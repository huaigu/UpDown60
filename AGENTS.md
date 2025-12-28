# Repository Guidelines

## Project Structure & Module Organization
- `app/` Next.js App Router pages (`layout.tsx`, `page.tsx`) and providers (`app/providers/`).
- `components/` reusable React components (PascalCase files like `FheCounter.tsx`).
- `src/lib/` shared utilities such as FHEVM instance helpers.
- `types/` global TypeScript declarations.
- `fhevm-sdk/` vendored SDK build artifacts.
- `hardhat/` smart-contract workspace (`contracts/`, `deploy/`, `hardhat.config.js`).

## Build, Test, and Development Commands
Root (Next.js):
- `npm install` install dependencies.
- `npm run dev` start local dev server at http://localhost:3000.
- `npm run build` create production build.
- `npm start` run the production server after build.
- `npm run lint` run Next.js ESLint rules.

Hardhat (smart contracts):
- `cd hardhat && npm install` install contract dependencies.
- `cd hardhat && npm run compile` compile contracts.
- `cd hardhat && npm run chain` start a local Hardhat node.
- `cd hardhat && npm run deploy:hardhat` deploy to local node.
- `cd hardhat && npm run deploy:sepolia` deploy to Sepolia.

## Coding Style & Naming Conventions
- TypeScript and React with 2-space indentation, semicolons, and single quotes (match existing files).
- React component files use PascalCase; hooks/variables use camelCase; constants use UPPER_SNAKE.
- Tailwind CSS is used for styling; keep utility class names readable and grouped.
- Use `next lint` before committing UI changes.
- Keep all code comments in English.
- Keep all UI text in English.

## Testing Guidelines
- No automated tests are configured at the repo root.
- The Hardhat package includes Mocha/Chai deps but no test folder yet; if you add tests, place them in `hardhat/test/` and run `cd hardhat && npx hardhat test`.
- For UI changes, do a quick manual pass in `npm run dev` (wallet connection, FHEVM initialization, component flows).

## Commit & Pull Request Guidelines
- Git history only contains the initial commit, so no established convention. Use short, imperative messages (e.g., `Add Sepolia switch flow`).
- PRs should include: a brief summary, testing notes (commands run), and screenshots/GIFs for UI changes.
- For contract changes, note the target network and any deployment/migration steps.

## FHEVM Initialization, Encryption, and Decryption Flow
- SDK load: `app/layout.tsx` injects the Relayer SDK script (`relayer-sdk-js.umd.cjs`) so `window.RelayerSDK`/`window.relayerSDK` exists in the browser.
- Initialization: `app/providers/FhevmProvider.tsx` calls `initializeFheInstance` from `src/lib/fhevmInstance.js`, which runs `initSDK()` (WASM load) and `createInstance({...SepoliaConfig, network: walletProvider})`, storing the result in a module-scoped `fheInstance`.
- Trigger: pages call `initialize()` after a Reown AppKit wallet connection, so initialization is gated by the wallet provider and the Relayer SDK being present.
- Encryption (`createEncryptedInput`): `src/lib/fhevmInstance.js` builds an input handle with `fhe.createEncryptedInput(contractAddress, userAddress)`, appends the value via `add32`, then `encrypt()`; it normalizes SDK output to `{ encryptedData, proof }` (prefers `handles[0]` + `inputProof` when present).
- Decryption: `decryptValue` uses EIP-712 user decryption (`generateKeypair` + `createEIP712` + `signTypedData` + `userDecrypt`); public flows use `publicDecrypt` for single handles and `decryptMultipleHandles` for multiple handles with proofs. Components (`components/FheCounter.tsx`, `components/FheRatings.tsx`, `components/FheVoting.tsx`) hexlify `Uint8Array` outputs before contract calls.
