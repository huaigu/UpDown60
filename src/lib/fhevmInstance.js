/**
 * Universal FHEVM SDK - Consolidated Instance
 * Complete FHEVM functionality in a single file for NPX packages
 * Includes: FHEVM instance, encryption, and decryption
 */

let fheInstance = null;

/**
 * Initialize FHEVM instance
 * Uses CDN for browser environments to avoid bundling issues
 */
export async function initializeFheInstance() {
    if (typeof window === 'undefined' || !window.ethereum) {
        throw new Error('Ethereum provider not found. Please install MetaMask or connect a wallet.');
    }
    
    // Check for both uppercase and lowercase versions of RelayerSDK
    let sdk = window.RelayerSDK || window.relayerSDK;
    if (!sdk) {
        throw new Error('RelayerSDK not loaded. Please include the script tag in your HTML:\n<script src="https://cdn.zama.org/relayer-sdk-js/0.3.0-5/relayer-sdk-js.umd.cjs"></script>');
    }
    
    const { initSDK, createInstance, SepoliaConfig } = sdk;
    await initSDK(); // Loads WASM
    
    const config = { ...SepoliaConfig, network: window.ethereum };
    
    try {
        fheInstance = await createInstance(config);
        return fheInstance;
    } catch (err) {
        console.error('FHEVM instance creation failed:', err);
        throw err;
    }
}

export function getFheInstance() {
    return fheInstance;
}

/**
 * Encrypt values using FHEVM
 */
export async function encryptValue(contractAddress, address, plainDigits) {
    const relayer = getFheInstance();
    if (!relayer) throw new Error("FHEVM not initialized");
    
    const inputHandle = relayer.createEncryptedInput(contractAddress, address);
    for (const d of plainDigits) {
        inputHandle.add8(d);
    }
    
    const ciphertextBlob = await inputHandle.encrypt();
    return ciphertextBlob;
}

/**
 * Create encrypted input for contract interaction (matches showcase API)
 */
export async function createEncryptedInput(contractAddress, userAddress, value) {
    const fhe = getFheInstance();
    if (!fhe) throw new Error('FHE instance not initialized. Call initializeFheInstance() first.');

    console.log(`🔐 Creating encrypted input for contract ${contractAddress}, user ${userAddress}, value ${value}`);
    
    const inputHandle = fhe.createEncryptedInput(contractAddress, userAddress);
    inputHandle.add32(value);
    const result = await inputHandle.encrypt();
    
    console.log('✅ Encrypted input created successfully');
    console.log('🔍 Encrypted result structure:', result);
    
    // The FHEVM SDK returns an object with handles and inputProof
    // We need to extract the correct values for the contract
    if (result && typeof result === 'object') {
        // If result has handles array, use the first handle
        if (result.handles && Array.isArray(result.handles) && result.handles.length > 0) {
            return {
                encryptedData: result.handles[0],
                proof: result.inputProof
            };
        }
        // If result has encryptedData and proof properties
        else if (result.encryptedData && result.proof) {
            return {
                encryptedData: result.encryptedData,
                proof: result.proof
            };
        }
        // Fallback: use the result as-is
        else {
            return {
                encryptedData: result,
                proof: result
            };
        }
    }
    
    // If result is not an object, use it directly
    return {
        encryptedData: result,
        proof: result
    };
}

/**
 * Request user decryption with EIP-712 signature
 */
export async function requestUserDecryption(contractAddress, signer, ciphertextHandle) {
    const relayer = getFheInstance();
    if (!relayer) throw new Error("FHEVM not initialized");
    
    const keypair = relayer.generateKeypair();
    const handleContractPairs = [
        {
            handle: ciphertextHandle,
            contractAddress: contractAddress,
        },
    ];
    
    const startTimeStamp = Math.floor(Date.now() / 1000).toString();
    const durationDays = "10";
    const contractAddresses = [contractAddress];
    
    const eip712 = relayer.createEIP712(keypair.publicKey, contractAddresses, startTimeStamp, durationDays);
    const signature = await signer.signTypedData(eip712.domain, {
        UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification,
    }, eip712.message);
    
    const result = await relayer.userDecrypt(handleContractPairs, keypair.privateKey, keypair.publicKey, signature.replace("0x", ""), contractAddresses, await signer.getAddress(), startTimeStamp, durationDays);
    return result[ciphertextHandle];
}

/**
 * Public decryption for a single handle
 * Returns the decrypted number value
 * @param {string} encryptedBytes - Single handle to decrypt
 * @returns {Promise<number>} Decrypted number value
 */
export async function publicDecrypt(encryptedBytes) {
    const fhe = getFheInstance();
    if (!fhe) throw new Error('FHE instance not initialized. Call initializeFheInstance() first.');
    
    try {
        let handle = encryptedBytes;
        if (typeof handle === "string" && handle.startsWith("0x") && handle.length === 66) {
            console.log('🔓 Calling publicDecrypt with handle:', handle);
            const result = await fhe.publicDecrypt([handle]);
            console.log('🔓 publicDecrypt returned:', result);
            
            // SDK 0.3.0-5 returns: {clearValues: {...}, abiEncodedClearValues: '...', decryptionProof: '...'}
            let decryptedValue;
            
            if (result && typeof result === 'object') {
                // Check for SDK 0.3.0-5 format with clearValues
                if (result.clearValues && typeof result.clearValues === 'object') {
                    // The decrypted value is in clearValues[handle] as a BigInt
                    decryptedValue = result.clearValues[handle];
                    console.log('🔓 Extracted from clearValues:', decryptedValue);
                    console.log('🔓 Value type:', typeof decryptedValue);
                    console.log('🔓 Is BigInt?', typeof decryptedValue === 'bigint');
                } else if (Array.isArray(result)) {
                    // Legacy array format
                    decryptedValue = result[0];
                    console.log('🔓 Extracted from array:', decryptedValue);
                } else {
                    // Try direct handle lookup (legacy format)
                    decryptedValue = result[handle] || Object.values(result)[0];
                    console.log('🔓 Extracted from object:', decryptedValue);
                }
            } else {
                // Direct value
                decryptedValue = result;
                console.log('🔓 Direct value:', decryptedValue);
            }
            
            // Convert BigInt or number to regular number
            let numberValue;
            if (typeof decryptedValue === 'bigint') {
                numberValue = Number(decryptedValue);
                console.log('🔓 Converted BigInt to number:', numberValue);
            } else {
                numberValue = Number(decryptedValue);
                console.log('🔓 Converted to number:', numberValue);
            }
            
            if (isNaN(numberValue)) {
                console.error('❌ Decryption returned NaN. Raw value:', decryptedValue);
                console.error('❌ Full response structure:', {
                    hasClearValues: !!result?.clearValues,
                    hasAbiEncoded: !!result?.abiEncodedClearValues,
                    hasProof: !!result?.decryptionProof,
                    clearValuesKeys: result?.clearValues ? Object.keys(result.clearValues) : []
                });
                throw new Error(`Decryption returned invalid value: ${decryptedValue}`);
            }
            
            console.log('🔓 Final number value:', numberValue);
            return numberValue;
        } else {
            throw new Error('Invalid ciphertext handle for decryption');
        }
    } catch (error) {
        console.error('❌ Decryption error:', error);
        if (error?.message?.includes('Failed to fetch') || error?.message?.includes('NetworkError')) {
            throw new Error('Decryption service is temporarily unavailable. Please try again later.');
        }
        throw error;
    }
}

/**
 * Public decryption for multiple handles with proof (for contract callbacks)
 * Returns cleartexts (ABI-encoded), decryption proof, and values array
 * Note: Handles must be made publicly decryptable (via makePubliclyDecryptable) before calling this
 * @param {string} contractAddress - The contract address (kept for compatibility, not used)
 * @param {Object} signer - Ethers signer object (kept for compatibility, not used)
 * @param {string[]} handles - Array of handles to decrypt
 * @returns {Object} { cleartexts: string, decryptionProof: string, values: number[] }
 */
export async function decryptMultipleHandles(contractAddress, signer, handles) {
    const relayer = getFheInstance();
    if (!relayer) throw new Error("FHEVM not initialized");
    
    if (!handles || handles.length === 0) {
        throw new Error("Handles array cannot be empty");
    }
    
    // Use publicDecrypt for multiple handles (requires handles to be publicly decryptable)
    // This is called after requestTallyReveal() makes handles publicly decryptable
    console.log('🔐 Calling publicDecrypt with handles:', handles);
    const result = await relayer.publicDecrypt(handles);
    
    console.log('🔐 publicDecrypt result structure:', {
        hasClearValues: !!result?.clearValues,
        hasAbiEncoded: !!result?.abiEncodedClearValues,
        hasProof: !!result?.decryptionProof,
        clearValuesKeys: result?.clearValues ? Object.keys(result.clearValues) : [],
        resultKeys: Object.keys(result || {})
    });
    
    // Extract decrypted values in order
    // publicDecrypt returns: { clearValues: { handle1: value1, handle2: value2 }, abiEncodedClearValues: '...', decryptionProof: '...' }
    const values = handles.map(handle => {
        let decrypted;
        
        // Check for SDK 0.3.0-5 format with clearValues (BigInt values)
        if (result?.clearValues && typeof result.clearValues === 'object') {
            decrypted = result.clearValues[handle];
            console.log(`🔐 Extracted ${handle} from clearValues:`, decrypted, 'Type:', typeof decrypted);
        } else if (result && typeof result === 'object') {
            // Try direct handle lookup (legacy format)
            decrypted = result[handle];
            console.log(`🔐 Extracted ${handle} from result:`, decrypted);
        } else {
            throw new Error(`Failed to decrypt handle: ${handle} - result format not recognized`);
        }
        
        if (decrypted === undefined || decrypted === null) {
            throw new Error(`Failed to decrypt handle: ${handle} - value not found`);
        }
        
        // Convert BigInt or number to regular number
        let numberValue;
        if (typeof decrypted === 'bigint') {
            numberValue = Number(decrypted);
            console.log(`🔐 Converted BigInt to number for ${handle}:`, numberValue);
        } else {
            numberValue = Number(decrypted);
        }
        
        if (isNaN(numberValue)) {
            throw new Error(`Decryption returned invalid value for handle ${handle}: ${decrypted}`);
        }
        
        return numberValue;
    });
    
    // Get the proof and encoded values
    const abiEncodedClearValues = result?.abiEncodedClearValues;
    const decryptionProof = result?.decryptionProof;
    
    console.log('🔐 Proof check:', {
        hasAbiEncoded: !!abiEncodedClearValues,
        hasProof: !!decryptionProof,
        proofType: typeof decryptionProof
    });
    
    if (!decryptionProof) {
        console.error('❌ Decryption proof not found. Full result:', result);
        throw new Error("Decryption proof not found in result. Result structure: " + JSON.stringify(Object.keys(result || {})));
    }
    
    // If abiEncodedClearValues is not provided, encode it ourselves
    let cleartexts;
    if (abiEncodedClearValues) {
        cleartexts = abiEncodedClearValues;
        console.log('🔐 Using abiEncodedClearValues from result');
    } else {
        // Encode as tuple (uint32, uint32, ...) for multiple values
        const { ethers } = await import('ethers');
        const abiCoder = ethers.AbiCoder.defaultAbiCoder();
        const types = handles.map(() => 'uint32');
        cleartexts = abiCoder.encode(types, values);
        console.log('🔐 Encoded cleartexts manually:', cleartexts);
    }
    
    console.log('🔐 Final values:', values);
    console.log('🔐 Cleartexts length:', cleartexts?.length);
    console.log('🔐 Proof length:', decryptionProof?.length);
    
    return {
        cleartexts,
        decryptionProof,
        values
    };
}

/**
 * Public decryption for multiple handles (raw result)
 * Returns the raw result from relayer.publicDecrypt()
 * @param {string[]} handles - Array of handles to decrypt
 * @returns {Promise<Object>} Raw result with clearValues, abiEncodedClearValues, decryptionProof
 */
export async function fetchPublicDecryption(handles) {
    const relayer = getFheInstance();
    if (!relayer) throw new Error("FHEVM not initialized");
    return relayer.publicDecrypt(handles);
}

/**
 * Decrypt a single encrypted value using EIP-712 user decryption (matches showcase API)
 * Note: Requires FHE.allow() permission for the caller
 */
export async function decryptValue(encryptedBytes, contractAddress, signer) {
    const fhe = getFheInstance();
    if (!fhe) throw new Error('FHE instance not initialized. Call initializeFheInstance() first.');
    
    try {
        console.log('🔐 Using EIP-712 user decryption for handle:', encryptedBytes);
        // Use EIP-712 user decryption instead of public decryption
        const keypair = fhe.generateKeypair();
        const handleContractPairs = [
            {
                handle: encryptedBytes,
                contractAddress: contractAddress,
            },
        ];
        
        const startTimeStamp = Math.floor(Date.now() / 1000).toString();
        const durationDays = "10";
        const contractAddresses = [contractAddress];
        
        const eip712 = fhe.createEIP712(keypair.publicKey, contractAddresses, startTimeStamp, durationDays);
        const signature = await signer.signTypedData(eip712.domain, {
            UserDecryptRequestVerification: eip712.types.UserDecryptRequestVerification,
        }, eip712.message);
        
        const result = await fhe.userDecrypt(handleContractPairs, keypair.privateKey, keypair.publicKey, signature.replace("0x", ""), contractAddresses, await signer.getAddress(), startTimeStamp, durationDays);
        return Number(result[encryptedBytes]);
    } catch (error) {
        // Check for relayer/network error
        if (error?.message?.includes('Failed to fetch') || error?.message?.includes('NetworkError')) {
            throw new Error('Decryption service is temporarily unavailable. Please try again later.');
        }
        throw error;
    }
}

