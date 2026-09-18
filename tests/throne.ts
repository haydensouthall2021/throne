import pkg from "@coral-xyz/anchor";
const { AnchorProvider, Program, BN, Wallet, workspace, setProvider } = pkg;
const anchor = { AnchorProvider, Program, BN, Wallet, workspace, setProvider };

import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getMint,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("throne — rounds", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Throne as Program<any>;
  const conn = provider.connection;
  const authority = (provider.wallet as anchor.Wallet).payer;

  // a short round, so the suite runs in seconds rather than ten minutes
  const ROUND = 60, ADD = 6, LOCK = 4;
  const FLOOR = 1_000_000_000;   // 1,000 tokens at 6dp
  const STEP = 11_500;           // 1.15x per take
  const CUT = 1_000;             // 10%

  let mint: PublicKey, treasury: Keypair;
  let alice: Keypair, bob: Keypair, carol: Keypair;
  let aliceAta: PublicKey, bobAta: PublicKey, carolAta: PublicKey;

  const throne = PublicKey.findProgramAddressSync([Buffer.from("throne")], program.programId)[0];
  const vault = PublicKey.findProgramAddressSync([Buffer.from("vault")], program.programId)[0];

  const fund = async (k: Keypair, s = 20) =>
    conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, s * LAMPORTS_PER_SOL));
  const sleep = (ms: number) => new Promise(r => setTimeout(r, Math.max(0, ms)));
  const state = () => program.account.throne.fetch(throne);
  const pot = () => conn.getBalance(vault);
  const untilEnd = async () => {
    const t = await state();
    return (t.endsAt.toNumber() - Math.floor(Date.now() / 1000) + 2) * 1000;
  };

  const take = (who: Keypair, ata: PublicKey, max = FLOOR * 50) =>
    program.methods.takeThrone(new BN(max))
      .accounts({ throne, vault, mint, takerTokens: ata, taker: who.publicKey,
                  tokenProgram: TOKEN_PROGRAM_ID })
      .signers([who]).rpc();

  const deposit = (amount: number, who?: Keypair) =>
    program.methods.depositFees(new BN(amount))
      .accounts({ throne, vault, treasury: treasury.publicKey,
                  payer: (who ?? authority).publicKey,
                  systemProgram: SystemProgram.programId })
      .signers(who ? [who] : []).rpc();

  const settle = (winner: PublicKey, cranker: Keypair) =>
    program.methods.settle()
      .accounts({ throne, vault, winner, cranker: cranker.publicKey,
                  systemProgram: SystemProgram.programId })
      .signers([cranker]).rpc();

  before(async () => {
    treasury = Keypair.generate();
    alice = Keypair.generate(); bob = Keypair.generate(); carol = Keypair.generate();
    await fund(alice); await fund(bob); await fund(carol); await fund(treasury, 1);
    mint = await createMint(conn, authority, authority.publicKey, null, 6);
    aliceAta = (await getOrCreateAssociatedTokenAccount(conn, alice, mint, alice.publicKey)).address;
    bobAta = (await getOrCreateAssociatedTokenAccount(conn, bob, mint, bob.publicKey)).address;
    carolAta = (await getOrCreateAssociatedTokenAccount(conn, carol, mint, carol.publicKey)).address;
    for (const a of [aliceAta, bobAta, carolAta]) {
      await mintTo(conn, authority, mint, a, authority, 200_000_000_000);
    }
  });

  it("starts round 1 with a clock running", async () => {
    await program.methods
      .initialize(new BN(ROUND), new BN(ADD), new BN(LOCK),
                  new BN(FLOOR), STEP, CUT)
      .accounts({ throne, vault, mint, treasury: treasury.publicKey,
                  authority: authority.publicKey, systemProgram: SystemProgram.programId })
      .rpc();

    const t = await state();
    assert.equal(t.round.toNumber(), 1);
    assert.ok(t.holder.equals(PublicKey.default), "the seat starts empty");
    const secs = t.endsAt.toNumber() - Math.floor(Date.now() / 1000);
    assert.ok(secs > ROUND - 15 && secs <= ROUND, "clock is ticking");
  });

  it("refuses immunity longer than a quarter of the round", async () => {
    try {
      await program.methods
        .initialize(new BN(60), new BN(5), new BN(40),
                    new BN(FLOOR), STEP, CUT)
        .accounts({ throne, vault, mint, treasury: treasury.publicKey,
                    authority: authority.publicKey, systemProgram: SystemProgram.programId })
        .rpc();
      assert.fail("should have been rejected");
    } catch (e) { assert.ok(e); }
  });

  it("lets a complete stranger fund the pot", async () => {
    const before = await conn.getBalance(treasury.publicKey);
    await deposit(4 * LAMPORTS_PER_SOL, carol);
    assert.approximately(await pot(), 3.6 * LAMPORTS_PER_SOL, 20000, "90% into the pot");
    assert.approximately(await conn.getBalance(treasury.publicKey) - before,
      0.4 * LAMPORTS_PER_SOL, 20000, "10% to the treasury");
  });

  it("burns tokens and pushes the clock back", async () => {
    const before = await state();
    const supplyBefore = (await getMint(conn, mint)).supply;

    await take(alice, aliceAta);

    const t = await state();
    assert.ok(t.holder.equals(alice.publicKey));
    assert.equal(Number(supplyBefore - (await getMint(conn, mint)).supply), FLOOR,
      "the tokens were destroyed against the mint, not moved");
    assert.equal(t.endsAt.toNumber(), before.endsAt.toNumber() + ADD, "clock extended");
    assert.equal(t.costTokens.toNumber(), FLOOR * STEP / 10_000, "next take costs 1.15x");
    assert.equal(t.takesThisRound, 1);
  });

  it("holds the immunity window", async () => {
    try {
      await take(bob, bobAta);
      assert.fail("immunity should have blocked this");
    } catch (e: any) { assert.include(e.toString(), "Immune"); }
  });

  it("will not settle while the clock is running", async () => {
    try {
      await settle(alice.publicKey, bob);
      assert.fail("the round is still live");
    } catch (e: any) { assert.include(e.toString(), "RoundRunning"); }
  });

  it("lets bob take it once immunity lapses, and caps the clock", async () => {
    await sleep((LOCK + 1) * 1000);
    await take(bob, bobAta);
    const t = await state();
    assert.ok(t.holder.equals(bob.publicKey));
    assert.ok(t.endsAt.toNumber() <= t.maxEnd.toNumber(),
      "extensions can never push past the round ceiling");
  });

  it("respects the taker's price limit", async () => {
    await sleep((LOCK + 1) * 1000);
    try {
      await take(carol, carolAta, 1);
      assert.fail("should not have overcharged");
    } catch (e: any) { assert.include(e.toString(), "CostMovedAgainstYou"); }
  });

  it("pays the holder at zero, triggered by a stranger", async () => {
    await sleep(await untilEnd());

    try {
      await take(carol, carolAta);
      assert.fail("the round is over");
    } catch (e: any) { assert.include(e.toString(), "RoundOver"); }

    const holder = (await state()).holder;
    const before = await conn.getBalance(holder);
    const inPot = await pot();

    await settle(holder, carol);   // carol triggers it, bob is paid

    assert.ok(await conn.getBalance(holder) > before + inPot * 0.95,
      "the whole pot went to the holder, not to whoever called it");

    const t = await state();
    assert.equal(t.round.toNumber(), 2, "round 2 has begun");
    assert.ok(t.holder.equals(PublicKey.default), "the seat is empty again");
    assert.equal(t.costTokens.toNumber(), FLOOR, "cost reset to the floor");
    assert.equal(t.takesThisRound, 0);
  });

  it("refuses to pay anyone other than the winner", async () => {
    await deposit(1 * LAMPORTS_PER_SOL);
    await take(alice, aliceAta);
    await sleep(await untilEnd());
    try {
      await settle(carol.publicKey, carol);
      assert.fail("carol is not the winner");
    } catch (e: any) { assert.include(e.toString(), "WrongWinner"); }
    await settle(alice.publicKey, carol);
  });

  it("rolls the pot over when nobody plays a round", async () => {
    await deposit(2 * LAMPORTS_PER_SOL);
    const potBefore = await pot();
    const before = await state();
    assert.ok(before.holder.equals(PublicKey.default), "nobody took the seat");
    await sleep(await untilEnd());

    await settle(carol.publicKey, carol);   // unplayed round: any writable account will do
    assert.approximately(await pot(), potBefore, 20000, "the pot carried over");
    assert.equal((await state()).round.toNumber(), before.round.toNumber() + 1);
  });

  it("pausing cannot trap a pot", async () => {
    await take(bob, bobAta);
    await program.methods.setPaused(true)
      .accounts({ throne, authority: authority.publicKey }).rpc();

    try {
      await deposit(LAMPORTS_PER_SOL);
      assert.fail("deposits should be paused");
    } catch (e: any) { assert.include(e.toString(), "Paused"); }

    await sleep(await untilEnd());
    await settle(bob.publicKey, carol);   // still pays out while paused

    await program.methods.setPaused(false)
      .accounts({ throne, authority: authority.publicKey }).rpc();
  });

  it("can give up the authority for good", async () => {
    await program.methods.setAuthority(SystemProgram.programId)
      .accounts({ throne, authority: authority.publicKey }).rpc();
    try {
      await program.methods.setPaused(true)
        .accounts({ throne, authority: authority.publicKey }).rpc();
      assert.fail("the old key should be powerless now");
    } catch (e) { assert.ok(e); }
  });
});
