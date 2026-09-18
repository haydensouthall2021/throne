/**
 * The keeper.
 *
 *   npx tsx scripts/keeper.ts
 *
 * Two jobs:
 *   1. settle a round the moment its clock hits zero, so the winner is paid
 *      without anyone having to press anything
 *   2. sweep creator fees into the pot
 *
 * Worth being clear about what this is and is not.
 *
 * It is NOT in control of the money. `settle` always pays whoever held the
 * seat — this process cannot redirect a single lamport, and it is
 * permissionless, so if it dies, any player can trigger the payout themselves
 * and nobody is stuck. It exists purely so that nobody has to.
 *
 * Nothing on a blockchain runs on a timer. Every state change needs a
 * transaction. This is the thing that sends it.
 */
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, workspace, setProvider } = pkg;
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import fs from "fs";

const POLL_MS = Number(process.env.POLL_MS ?? 2000);
const SWEEP_MS = Number(process.env.SWEEP_MS ?? 60_000);
const FEE_FLOAT = 0.05 * LAMPORTS_PER_SOL;   // leave this behind for gas
const MIN_SWEEP = 0.01 * LAMPORTS_PER_SOL;

async function main() {
  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Throne;
  const conn = provider.connection;
  const me = provider.wallet.publicKey;

  const launch = JSON.parse(fs.readFileSync("./launch.json", "utf8"));
  const thronePda = new PublicKey(launch.throne);
  const vaultPda = new PublicKey(launch.pot);
  const treasury = new PublicKey(launch.treasury);

  console.log("keeper up");
  console.log("  rpc     ", conn.rpcEndpoint);
  console.log("  throne  ", thronePda.toBase58());
  console.log("  pot     ", vaultPda.toBase58());
  console.log("  settling rounds the second they end\n");

  let settling = false;

  async function watch() {
    if (settling) return;
    try {
      const t = await program.account.throne.fetch(thronePda);
      const now = Math.floor(Date.now() / 1000);
      const left = t.endsAt.toNumber() - now;
      if (left > 0) return;

      settling = true;
      const holder = t.holder as PublicKey;
      const empty = holder.equals(PublicKey.default);
      const pot = await conn.getBalance(vaultPda);

      const sig = await program.methods
        .settle()
        .accounts({
          throne: thronePda,
          vault: vaultPda,
          // an unplayed round pays nobody, so any writable account will do
          winner: empty ? me : holder,
          cranker: me,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const stamp = new Date().toISOString().slice(11, 19);
      if (empty) {
        console.log(`${stamp}  round ${t.round} ended with nobody on the seat — pot rolls over`);
      } else {
        console.log(`${stamp}  round ${t.round} paid ${(pot / LAMPORTS_PER_SOL).toFixed(4)} SOL to ${holder.toBase58()}`);
        console.log(`          ${sig}`);
      }
    } catch (e: any) {
      const m = String(e?.message ?? e);
      // RoundRunning just means we were a touch early; try again next tick
      if (!m.includes("RoundRunning")) console.error("settle failed:", m.slice(0, 120));
    } finally {
      settling = false;
    }
  }

  async function sweep() {
    try {
      const bal = await conn.getBalance(me);
      const amount = bal - FEE_FLOAT;
      if (amount < MIN_SWEEP) return;
      // in production this wallet is the creator-fee wallet, not the keeper's own
      if (!process.env.SWEEP_ENABLED) return;
      await program.methods
        .depositFees(new BN(amount))
        .accounts({ throne: thronePda, vault: vaultPda, treasury, payer: me,
                    systemProgram: SystemProgram.programId })
        .rpc();
      console.log(`swept ${(amount / LAMPORTS_PER_SOL).toFixed(4)} SOL into the pot`);
    } catch (e: any) {
      console.error("sweep failed:", String(e?.message ?? e).slice(0, 120));
    }
  }

  setInterval(watch, POLL_MS);
  setInterval(sweep, SWEEP_MS);
  await watch();

  process.on("SIGINT", () => { console.log("\nkeeper stopping. players can still settle rounds themselves."); process.exit(0); });
}

main().catch(e => { console.error(e); process.exit(1); });
