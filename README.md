# BTC Up/Down FHEVM Contract Flow

Round length: 5 minutes.
Users bet only on the NEXT round.
Stake amount is public; direction (up/down) stays encrypted.

Actors
- User
- Contract
- Chainlink Automation (optional for finalize only)
- First claimer (user or operator running the SDK for public decrypt)

Flow (high level)
1) placeBet(roundId + 1, encDirection, stake)
   - encTotalUp / encTotalDown are updated with FHE select
2) finalizeRound(roundId)
   - reads BTC/USD from Chainlink and sets result (up/down/tie)
3) requestRoundReveal(roundId)
   - encrypted total handles are emitted
4) First claimer uses SDK publicDecrypt(handles)
   - obtains cleartexts + decryptionProof
5) resolveTotalsCallback(roundId, cleartexts, proof)
   - totals stored on-chain, fee computed
6) requestClaim(roundId)
   - per-user payout handle is emitted
7) Claimer uses SDK publicDecrypt(payoutHandle)
   - obtains cleartexts + decryptionProof
8) claimCallback(roundId, cleartexts, proof)
   - payout is transferred

ASCII diagram

User/Claimer                    Contract
------------                    --------
placeBet(enc dir, stake)   ->   enc totals updated
finalizeRound(roundId)     ->   result set from price feed
requestRoundReveal()       ->   emit total handles
publicDecrypt(handles)     ->   cleartexts + proof
resolveTotalsCallback()    ->   totals stored
requestClaim()             ->   emit payout handle
publicDecrypt(handle)      ->   cleartexts + proof
claimCallback()            ->   payout transfer
