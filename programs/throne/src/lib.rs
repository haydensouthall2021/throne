use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::token_interface::{self as token, Burn, Mint, TokenAccount, TokenInterface};

declare_id!("6AqWpXAFSEN73NZQFzcAo7mZjCgNEy7fkULwDMSPwddq");

/// The Throne.
///
/// A clock runs down. Whoever holds the Throne when it reaches zero takes the
/// whole pot. Anyone can take the Throne by burning tokens, which buys them a
/// short immunity and pushes the clock back.
///
/// Worth understanding before reading further:
///
/// 1. **Nobody holds the pot.** It sits at a PDA, an address derived from the
///    program itself, for which no private key exists. The only instruction
///    that moves SOL out is `settle`, and it can only pay the round's winner.
///
/// 2. **`settle` is permissionless.** Anyone can call it once the clock is up,
///    and it always pays the holder rather than the caller. There is no way for
///    the payout to be withheld — if the winner will not call it, a rival who
///    wants the next round to start will.
///
/// 3. **The cost to take is a token ratchet, not a price feed.** A program
///    cannot see what the token is worth in SOL without trusting an oracle, and
///    an oracle can be manipulated for a block and drained. So the cost rises a
///    fixed step with each take and resets to the floor each round.
#[program]
pub mod throne {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        round_seconds: i64,
        add_seconds: i64,
        lock_seconds: i64,
        floor_tokens: u64,
        floor_bps: u16,
        step_bps: u16,
        cut_bps: u16,
    ) -> Result<()> {
        require!((60..=86_400).contains(&round_seconds), ThroneError::BadRound);
        require!((0..=600).contains(&add_seconds), ThroneError::BadAdd);
        require!((0..=300).contains(&lock_seconds), ThroneError::BadLock);
        require!(lock_seconds <= round_seconds / 4, ThroneError::LockTooLong);
        require!((10_000..=30_000).contains(&step_bps), ThroneError::BadStep);
        require!(cut_bps <= 2_000, ThroneError::BadCut);
        require!(floor_tokens > 0, ThroneError::BadFloor);
        // 1 to 500 bps — a take costs between 0.01% and 5% of whatever supply is left
        require!((1..=500).contains(&floor_bps), ThroneError::BadFloor);

        let clock = Clock::get()?;
        let t = &mut ctx.accounts.throne;
        t.authority = ctx.accounts.authority.key();
        t.mint = ctx.accounts.mint.key();
        t.treasury = ctx.accounts.treasury.key();
        t.holder = Pubkey::default();
        t.round = 1;
        t.round_seconds = round_seconds;
        t.add_seconds = add_seconds;
        t.lock_seconds = lock_seconds;
        t.max_end = clock.unix_timestamp + round_seconds * 2;
        t.ends_at = clock.unix_timestamp + round_seconds;
        t.locked_until = 0;
        t.floor_tokens = floor_tokens;
        t.cost_tokens = floor_tokens;
        t.step_bps = step_bps;
        t.cut_bps = cut_bps;
        t.takes_this_round = 0;
        t.total_burned = 0;
        t.total_paid_out = 0;
        t.rounds_settled = 0;
        t.paused = false;
        t.bump = ctx.bumps.throne;
        t.vault_bump = ctx.bumps.vault;
        t.floor_bps = floor_bps;

        emit!(Founded { mint: t.mint, round_seconds, ends_at: t.ends_at });
        Ok(())
    }

    /// Push SOL into the pot. Permissionless — the fee wallet, a keeper, or a
    /// stranger. None of them can take it back out.
    pub fn deposit_fees(ctx: Context<DepositFees>, amount: u64) -> Result<()> {
        require!(amount > 0, ThroneError::ZeroAmount);
        require!(!ctx.accounts.throne.paused, ThroneError::Paused);

        let cut = (amount as u128)
            .checked_mul(ctx.accounts.throne.cut_bps as u128)
            .ok_or(ThroneError::Overflow)? / 10_000;
        let cut = u64::try_from(cut).map_err(|_| ThroneError::Overflow)?;
        let to_pot = amount.checked_sub(cut).ok_or(ThroneError::Overflow)?;

        if cut > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                    },
                ),
                cut,
            )?;
        }
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            to_pot,
        )?;

        emit!(FeesIn { amount: to_pot, cut, pot: ctx.accounts.vault.lamports() });
        Ok(())
    }

    /// Burn tokens, take the seat, push the clock back.
    ///
    /// Refuses once the clock has run out — at that point the round is over and
    /// somebody must call `settle` before a new one can start. Without this, a
    /// late transaction could steal a round that was already won.
    pub fn take_throne(ctx: Context<TakeThrone>, max_cost: u64) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;

        let cost = {
            let t = &ctx.accounts.throne;
            require!(!t.paused, ThroneError::Paused);
            require!(now < t.ends_at, ThroneError::RoundOver);
            require!(now >= t.locked_until, ThroneError::Immune);
            require_keys_neq!(ctx.accounts.taker.key(), t.holder, ThroneError::AlreadyYours);
            // The floor tracks the supply that is actually left. Burn half the
            // tokens and a take costs half as many — so a heavily burned coin
            // stays as playable as a fresh one, and whales cannot price it out.
            let supply = ctx.accounts.mint.supply as u128;
            let dynamic = (supply * t.floor_bps as u128 / 10_000) as u64;
            let floor = dynamic.max(t.floor_tokens);
            t.cost_tokens.max(floor)
        };
        require!(cost <= max_cost, ThroneError::CostMovedAgainstYou);

        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.taker_tokens.to_account_info(),
                    authority: ctx.accounts.taker.to_account_info(),
                },
            ),
            cost,
        )?;

        let previous = ctx.accounts.throne.holder;
        let t = &mut ctx.accounts.throne;
        t.holder = ctx.accounts.taker.key();
        t.locked_until = now + t.lock_seconds;

        // the clock stretches, but never past the round's hard ceiling, so a
        // well-funded pair cannot keep one round alive indefinitely
        t.ends_at = (t.ends_at + t.add_seconds).min(t.max_end);
        // Immunity can never outlast the round. Extending the round to fit the
        // immunity would let two wallets walk past max_end one late take at a
        // time, which is exactly what the ceiling exists to prevent.
        if t.locked_until > t.ends_at {
            t.locked_until = t.ends_at;
        }

        t.cost_tokens = ((cost as u128)
            .checked_mul(t.step_bps as u128)
            .ok_or(ThroneError::Overflow)? / 10_000) as u64;
        t.total_burned = t.total_burned.saturating_add(cost);
        t.takes_this_round = t.takes_this_round.saturating_add(1);

        emit!(Taken {
            round: t.round,
            taker: t.holder,
            previous,
            burned: cost,
            next_cost: t.cost_tokens,
            ends_at: t.ends_at,
            locked_until: t.locked_until,
            pot: ctx.accounts.vault.lamports(),
        });
        Ok(())
    }

    /// Pay the round out and start the next one.
    ///
    /// Anyone may call this. It always pays the holder, never the caller, so
    /// there is nothing to gain by racing for it — only a new round to start.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        require!(now >= ctx.accounts.throne.ends_at, ThroneError::RoundRunning);

        let holder = ctx.accounts.throne.holder;
        let mut payout = 0u64;

        // an empty seat means nobody played; the pot rolls into the next round
        if holder != Pubkey::default() {
            require_keys_eq!(ctx.accounts.winner.key(), holder, ThroneError::WrongWinner);

            let rent = Rent::get()?.minimum_balance(0);
            payout = ctx.accounts.vault.lamports().saturating_sub(rent);

            if payout > 0 {
                // The vault is system-owned, so the program cannot debit it
                // directly. It asks the system program and proves control of
                // the PDA by signing with its seeds.
                let bump = ctx.accounts.throne.vault_bump;
                let seeds: &[&[u8]] = &[b"vault", &[bump]];
                system_program::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.system_program.to_account_info(),
                        system_program::Transfer {
                            from: ctx.accounts.vault.to_account_info(),
                            to: ctx.accounts.winner.to_account_info(),
                        },
                        &[seeds],
                    ),
                    payout,
                )?;
            }
        }

        let t = &mut ctx.accounts.throne;
        t.total_paid_out = t.total_paid_out.saturating_add(payout);
        t.rounds_settled = t.rounds_settled.saturating_add(1);
        t.round = t.round.saturating_add(1);
        t.holder = Pubkey::default();
        t.locked_until = 0;
        t.takes_this_round = 0;
        // zero means "use the supply-derived floor", computed fresh at the next take
        t.cost_tokens = 0;
        t.ends_at = now + t.round_seconds;
        t.max_end = t.ends_at + t.round_seconds;

        emit!(Settled {
            round: t.round - 1,
            winner: holder,
            payout,
            next_round_ends: t.ends_at,
        });
        Ok(())
    }

    /// Stops deposits and takes. Deliberately cannot stop `settle`, so a lost or
    /// hostile authority key can never trap a round's pot.
    pub fn set_paused(ctx: Context<AuthorityOnly>, paused: bool) -> Result<()> {
        ctx.accounts.throne.paused = paused;
        emit!(PauseSet { paused });
        Ok(())
    }

    /// Hand over the authority, or set it to the system program to give it up.
    pub fn set_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.throne.authority = new_authority;
        emit!(AuthorityChanged { new_authority });
        Ok(())
    }
}

// ───────────────────────────────────────────────────────────── state

#[account]
pub struct Throne {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
    pub holder: Pubkey,
    pub round: u64,
    pub round_seconds: i64,
    pub add_seconds: i64,
    pub lock_seconds: i64,
    pub ends_at: i64,
    pub max_end: i64,
    pub locked_until: i64,
    pub floor_tokens: u64,
    pub cost_tokens: u64,
    pub step_bps: u16,
    pub cut_bps: u16,
    pub takes_this_round: u32,
    pub total_burned: u64,
    pub total_paid_out: u64,
    pub rounds_settled: u64,
    pub paused: bool,
    pub bump: u8,
    pub vault_bump: u8,
    /// The real floor is this share of the CURRENT supply, so as tokens burn the
    /// cost to take the seat falls with them and the game stays playable.
    pub floor_bps: u16,
}

impl Throne {
    pub const LEN: usize = 8 + 32 * 4 + 8 + 8 * 6 + 8 * 2 + 2 + 2 + 4 + 8 * 3 + 1 + 1 + 1 + 2;
}

// ───────────────────────────────────────────────────────────── contexts

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = authority, space = Throne::LEN, seeds = [b"throne"], bump)]
    pub throne: Account<'info, Throne>,
    /// CHECK: lamport-only PDA; the pot. No private key exists for it.
    #[account(seeds = [b"vault"], bump)]
    pub vault: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: receives the creator cut; only ever receives lamports
    pub treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositFees<'info> {
    #[account(mut, seeds = [b"throne"], bump = throne.bump, has_one = treasury)]
    pub throne: Account<'info, Throne>,
    /// CHECK: lamport-only PDA, address fixed by seeds
    #[account(mut, seeds = [b"vault"], bump = throne.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: verified against throne.treasury by has_one
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TakeThrone<'info> {
    #[account(mut, seeds = [b"throne"], bump = throne.bump, has_one = mint)]
    pub throne: Account<'info, Throne>,
    /// CHECK: lamport-only PDA, read for the event only
    #[account(seeds = [b"vault"], bump = throne.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut,
        constraint = taker_tokens.mint == mint.key() @ ThroneError::WrongMint,
        constraint = taker_tokens.owner == taker.key() @ ThroneError::NotYourTokens)]
    pub taker_tokens: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub taker: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [b"throne"], bump = throne.bump)]
    pub throne: Account<'info, Throne>,
    /// CHECK: lamport-only PDA, address fixed by seeds
    #[account(mut, seeds = [b"vault"], bump = throne.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must equal throne.holder when there is one; checked in the handler.
    /// For an unplayed round, pass any writable account — it receives nothing.
    #[account(mut)]
    pub winner: UncheckedAccount<'info>,
    /// anyone at all may trigger the payout
    pub cranker: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(mut, seeds = [b"throne"], bump = throne.bump, has_one = authority)]
    pub throne: Account<'info, Throne>,
    pub authority: Signer<'info>,
}

// ───────────────────────────────────────────────────────────── events

#[event]
pub struct Founded { pub mint: Pubkey, pub round_seconds: i64, pub ends_at: i64 }
#[event]
pub struct FeesIn { pub amount: u64, pub cut: u64, pub pot: u64 }
#[event]
pub struct Taken {
    pub round: u64,
    pub taker: Pubkey,
    pub previous: Pubkey,
    pub burned: u64,
    pub next_cost: u64,
    pub ends_at: i64,
    pub locked_until: i64,
    pub pot: u64,
}
#[event]
pub struct Settled { pub round: u64, pub winner: Pubkey, pub payout: u64, pub next_round_ends: i64 }
#[event]
pub struct PauseSet { pub paused: bool }
#[event]
pub struct AuthorityChanged { pub new_authority: Pubkey }

// ───────────────────────────────────────────────────────────── errors

#[error_code]
pub enum ThroneError {
    #[msg("Round must be between 1 minute and 24 hours")]
    BadRound,
    #[msg("Time added per take must be 0 to 600 seconds")]
    BadAdd,
    #[msg("Immunity must be 0 to 300 seconds")]
    BadLock,
    #[msg("Immunity cannot exceed a quarter of the round")]
    LockTooLong,
    #[msg("Step must be between 1.0x and 3.0x")]
    BadStep,
    #[msg("Creator cut cannot exceed 20%")]
    BadCut,
    #[msg("Floor must be above zero")]
    BadFloor,
    #[msg("Amount must be above zero")]
    ZeroAmount,
    #[msg("The Throne is paused")]
    Paused,
    #[msg("This round is over. Settle it before taking the Throne again")]
    RoundOver,
    #[msg("The holder is still immune")]
    Immune,
    #[msg("You already hold the Throne")]
    AlreadyYours,
    #[msg("Cost rose above your limit before your transaction landed")]
    CostMovedAgainstYou,
    #[msg("The round is still running")]
    RoundRunning,
    #[msg("That account is not the winner of this round")]
    WrongWinner,
    #[msg("That token account is for a different mint")]
    WrongMint,
    #[msg("That token account is not yours")]
    NotYourTokens,
    #[msg("Arithmetic overflow")]
    Overflow,
}
