// Type declarations for fhevmInstance.js

export interface EncryptedInput {
  encryptedData: string;
  proof: string;
}

export interface DecryptMultipleResult {
  cleartexts: string;
  decryptionProof: string;
  values: number[];
}

// Main exports
export declare function decryptValue(handle: string, contractAddress: string, signer: any): Promise<number>;
export declare function createEncryptedInput(contractAddress: string, userAddress: string, value: number): Promise<EncryptedInput>;
export declare function publicDecrypt(encryptedData: string): Promise<number>;
export declare function decryptMultipleHandles(contractAddress: string, signer: any, handles: string[]): Promise<DecryptMultipleResult>;
export declare function fetchPublicDecryption(handles: string[]): Promise<any>;
export declare function initializeFheInstance(): Promise<any>;
export declare function getFheInstance(): any;
