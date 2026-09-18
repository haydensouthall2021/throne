/**
 * Point the Throne at a coin that already exists.
 *
 *   MINT=<pump.fun mint address> TREASURY=<fee wallet> npx tsx scripts/init.ts
 *
 * Use this rather than launch.ts when the coin was created somewhere that
 * actually makes a market — pump.fun, Bags, LetsBonk. Those put the token on a
 * bonding curve straight away, which is what gets it indexed by Axiom, DexScreener
 * and the rest. A bare SPL mint with no pool is invisible to all of them.
 *
 * The order matters:
 *   1. launch the coin on the launchpad, get its mint address
 *   2. run this to found the Throne against that mint
 *   3. put the mint in the site config as buyUrl
 *   4. start the keeper
 *
 * Once founded, the mint is fixed in the program forever. The Throne will only
 * ever burn that token. Check the address twice.
 */
import pkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, workspace, setProvider } = pkg;
import { PublicKey, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import fs from "fs";

// ─────────── settings ───────────
const ROUND_SECONDS = 600;     // 10 minute rounds
const ADD_SECONDS = 30;        // each take pushes the clock back 30s
const LOCK_SECONDS = 20;       // immunity after taking the seat
const FLOOR_BPS = 25;          // a take costs 0.25% of REMAINING supply
const FLOOR_TOKENS_RAW = 1;    // absolute dust backstop, in base units
const STEP_BPS = 11_500;       // each take costs 1.15x the last, resets each round
const CUT_BPS = 1_000;         // 10% of fees to the treasury
// ────────────────────────────────

async function main() {
  const mintStr = process.env.MINT;
  if (!mintStr) throw new Error("Set MINT to the coin's address. See the header of this file.");
  const mint = new PublicKey(mintStr);

  const provider = AnchorProvider.env();
  setProvider(provider);
  const program = workspace.Throne;
  const conn = provider.connection;
  const me = provider.wallet.publicKey;
  const treasury = process.env.TREASURY ? new PublicKey(process.env.TREASURY) : me;

  console.log("\ncluster  :", conn.rpcEndpoint);
  console.log("deployer :", me.toBase58());
  console.log("treasury :", treasury.toBase58());
  console.log("mint     :", mint.toBase58());

  // sanity-check the coin before tying the Throne to it permanently
  const info = await getMint(conn, mint);
  const supply = Number(info.supply) / 10 ** info.decimals;
  console.log("\nthe coin:");
  console.log("  supply         ", supply.toLocaleString());
  console.log("  decimals       ", info.decimals);
  console.log("  mint authority ", info.mintAuthority ? "STILL LIVE — supply can be inflated" : "revoked ✓");
  console.log("  freeze authority", info.freezeAuthority ? "STILL LIVE — accounts can be frozen" : "revoked ✓");

  if (info.mintAuthority) {
    console.log("\n  A live mint authority means whoever holds it can print more tokens");
    console.log("  and take the Throne for free. Do not proceed unless that is you and");
    console.log("  you intend to revoke it.");
  }
  if (info.freezeAuthority) {
    console.log("\n  A live freeze authority means someone can freeze holders' accounts.");
  }

  const cost = Number(info.supply) * FLOOR_BPS / 10_000 / 10 ** info.decimals;
  console.log(`\n  at ${FLOOR_BPS} bps, a take costs ${cost.toLocaleString()} tokens (${(FLOOR_BPS/100).toFixed(2)}% of supply)`);

  if (!process.env.CONFIRM) {
    console.log("\nNothing has been written. Re-run with CONFIRM=1 to found the Throne.");
    console.log("This is permanent — the mint cannot be changed afterwards.\n");
    return;
  }

  const thronePda = PublicKey.findProgramAddressSync([Buffer.from("throne")], program.programId)[0];
  const vaultPda = PublicKey.findProgramAddressSync([Buffer.from("vault")], program.programId)[0];

  console.log(`\nfounding — ${ROUND_SECONDS / 60} min rounds, +${ADD_SECONDS}s per take, ${LOCK_SECONDS}s immunity…`);
  const sig = await program.methods
    .initialize(
      new BN(ROUND_SECONDS), new BN(ADD_SECONDS), new BN(LOCK_SECONDS),
      new BN(FLOOR_TOKENS_RAW), FLOOR_BPS, STEP_BPS, CUT_BPS
    )
    .accounts({
      throne: thronePda, vault: vaultPda, mint, treasury,
      authority: me, systemProgram: SystemProgram.programId,
    })
    .rpc();

  const out = {
    cluster: conn.rpcEndpoint,
    programId: program.programId.toBase58(),
    mint: mint.toBase58(),
    throne: thronePda.toBase58(),
    pot: vaultPda.toBase58(),
    treasury: treasury.toBase58(),
    foundedAt: new Date().toISOString(),
  };
  fs.writeFileSync("./launch.json", JSON.stringify(out, null, 2));

  console.log("  tx:", sig);
  console.log("\n─────────────────────────────────────────────");
  console.log("mint (the CA) ", out.mint);
  console.log("pot           ", out.pot);
  console.log("program       ", out.programId);
  console.log("─────────────────────────────────────────────");
  console.log("\nPublish the pot address. Anyone can check its balance and nobody");
  console.log("holds a key for it.\n");
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
