import { MultiSigPublicKey } from "@socialproof/myso/multisig";
import type { PublicKey } from "@socialproof/myso/cryptography";
import { Ed25519PublicKey } from "@socialproof/myso/keypairs/ed25519";
import { Secp256k1PublicKey } from "@socialproof/myso/keypairs/secp256k1";
import { Secp256r1PublicKey } from "@socialproof/myso/keypairs/secp256r1";
import { PasskeyPublicKey } from "@socialproof/myso/keypairs/passkey";
import { ZkLoginPublicIdentifier } from "@socialproof/myso/zklogin";
import { Transaction } from "@socialproof/myso/transactions";

export interface MySoMultisigMember {
  address: string;
  publicKey: Uint8Array;
  weight: number;
}

interface MultisigWalletAccount {
  address: string;
  publicKey: Uint8Array;
  chains: readonly `${string}:${string}`[];
  features: readonly `${string}:${string}`[];
}

interface MultisigWallet {
  name: string;
  features: {
    "myso:signTransaction"?: {
      signTransaction(input: {
        transaction: { toJSON: () => Promise<string> };
        account: MultisigWalletAccount;
        chain: `${string}:${string}`;
      }): Promise<{ bytes: string; signature: string }>;
    };
    "myso:signTransactionBlock"?: {
      signTransactionBlock(input: {
        transactionBlock: Transaction;
        account: MultisigWalletAccount;
        chain: `${string}:${string}`;
      }): Promise<{ transactionBlockBytes: string; signature: string }>;
    };
  };
}

interface PersonalMessageWallet {
  name: string;
  features: {
    "myso:signPersonalMessage"?: {
      signPersonalMessage(input: {
        message: Uint8Array;
        account: MultisigWalletAccount;
        chain: `${string}:${string}`;
      }): Promise<{ bytes: string; signature: string }>;
    };
  };
}

/**
 * Resolve a Wallet Standard account key without guessing its scheme from key
 * length alone. The account's advertised MySo address must match the key.
 */
export function resolveMySoAccountPublicKey(account: {
  address: string;
  publicKey: Uint8Array;
}): PublicKey {
  const candidates: PublicKey[] = [];
  for (const KeyType of [Ed25519PublicKey, Secp256k1PublicKey, Secp256r1PublicKey, PasskeyPublicKey, ZkLoginPublicIdentifier]) {
    try {
      candidates.push(new KeyType(account.publicKey));
    } catch {
      // A key encoding can be valid for one scheme and invalid for another.
    }
  }
  const matches = candidates.filter((key) => key.verifyAddress(account.address));
  if (matches.length !== 1) {
    throw new Error("This wallet account does not expose one unambiguous MySo signing key.");
  }
  return matches[0]!;
}

export function buildMySoMultisig(members: MySoMultisigMember[], threshold: number) {
  if (members.length < 2 || members.length > 10) {
    throw new Error("A multisig needs between 2 and 10 wallet members.");
  }
  if (new Set(members.map(({ address }) => address.toLowerCase())).size !== members.length) {
    throw new Error("Each wallet can appear only once in a multisig.");
  }
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 65535) {
    throw new Error("The multisig threshold must be a positive integer.");
  }
  for (const member of members) {
    if (!Number.isInteger(member.weight) || member.weight < 1 || member.weight > 255) {
      throw new Error("Each signer weight must be an integer from 1 to 255.");
    }
  }
  const totalWeight = members.reduce((sum, member) => sum + member.weight, 0);
  if (threshold > totalWeight) {
    throw new Error("The threshold cannot exceed the combined signer weight.");
  }
  const publicKey = MultiSigPublicKey.fromPublicKeys({
    threshold,
    publicKeys: members.map((member) => ({
      publicKey: resolveMySoAccountPublicKey(member),
      weight: member.weight,
    })),
  });
  return { address: publicKey.toMySoAddress(), publicKey, members, threshold };
}

/** Combine native wallet signatures only when they all sign identical bytes. */
export async function combineMySoMultisigSignatures(
  multisig: MultiSigPublicKey,
  signedParts: Array<{ bytes: string; signature: string }>,
) {
  if (!signedParts.length || signedParts.some((part) => part.bytes !== signedParts[0]!.bytes)) {
    throw new Error("Every multisig participant must sign the same transaction bytes.");
  }
  const signature = multisig.combinePartialSignatures(signedParts.map(({ signature: value }) => value));
  const binary = atob(signedParts[0]!.bytes);
  const transactionBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const valid = await multisig.verifyTransaction(transactionBytes, signature);
  if (!valid) throw new Error("The combined wallet signatures did not verify for this multisig.");
  return { bytes: signedParts[0]!.bytes, signature };
}

/**
 * Prompt each selected Wallet Standard account to sign the exact same prepared
 * transaction, then produce and locally verify the protocol multisig signature.
 * The caller must prepare the transaction with the derived multisig address as
 * sender and submit the returned bytes/signature through the chain client.
 */
export async function signMySoTransactionWithMultisig(args: {
  multisig: ReturnType<typeof buildMySoMultisig>;
  transactionBlockBase64: string;
  chain: `${string}:${string}`;
  signers: Array<{ wallet: MultisigWallet; account: MultisigWalletAccount }>;
}) {
  const transactionBlock = Transaction.from(args.transactionBlockBase64);
  const transactionSender = (transactionBlock.getData() as { sender?: string | null }).sender;
  const canonicalAddress = (value: string) => value.replace(/^0x/i, "").toLowerCase().padStart(64, "0");
  if (!transactionSender || canonicalAddress(transactionSender) !== canonicalAddress(args.multisig.address)) {
    throw new Error("The prepared transaction sender must be the configured multisig address.");
  }
  const allowed = new Map(args.multisig.members.map((member) => [member.address.toLowerCase(), member]));
  const unique = new Set<string>();
  const signatures: Array<{ bytes: string; signature: string }> = [];
  for (const { wallet, account } of args.signers) {
    const key = account.address.toLowerCase();
    if (unique.has(key)) throw new Error("A multisig participant can sign only once.");
    unique.add(key);
    const member = allowed.get(key);
    if (!member || !resolveMySoAccountPublicKey(account).verifyAddress(member.address)) {
      throw new Error("A connected wallet account is not one of the configured multisig members.");
    }
    const transaction = { toJSON: async () => args.transactionBlockBase64 };
    if (wallet.features["myso:signTransaction"]) {
      signatures.push(await wallet.features["myso:signTransaction"].signTransaction({
        transaction, account, chain: args.chain,
      }));
    } else if (wallet.features["myso:signTransactionBlock"]) {
      const signed = await wallet.features["myso:signTransactionBlock"].signTransactionBlock({
        transactionBlock, account, chain: args.chain,
      });
      signatures.push({ bytes: signed.transactionBlockBytes, signature: signed.signature });
    } else {
      throw new Error(`${wallet.name} does not support MySo transaction signing.`);
    }
  }
  return combineMySoMultisigSignatures(args.multisig.publicKey, signatures);
}

/** Combine wallet signatures over the exact approval-intent message. */
export async function signMySoMessageWithMultisig(args: {
  multisig: ReturnType<typeof buildMySoMultisig>;
  message: Uint8Array;
  chain: `${string}:${string}`;
  signers: Array<{ wallet: PersonalMessageWallet; account: MultisigWalletAccount }>;
}): Promise<string> {
  const binary = String.fromCharCode(...args.message);
  const expectedBytes = btoa(binary);
  const unique = new Set<string>();
  const signatures: Array<{ bytes: string; signature: string }> = [];
  for (const { wallet, account } of args.signers) {
    const key = account.address.toLowerCase();
    if (unique.has(key)) throw new Error("A multisig participant can sign only once.");
    unique.add(key);
    const member = args.multisig.members.find((candidate) => candidate.address.toLowerCase() === key);
    if (!member || !resolveMySoAccountPublicKey(account).verifyAddress(member.address)) {
      throw new Error("A connected wallet account is not one of the configured multisig members.");
    }
    const feature = wallet.features["myso:signPersonalMessage"];
    if (!feature) throw new Error(`${wallet.name} does not support MySo personal-message signing.`);
    const signed = await feature.signPersonalMessage({ message: args.message, account, chain: args.chain });
    if (signed.bytes !== expectedBytes) throw new Error(`${wallet.name} signed different approval-intent bytes.`);
    signatures.push(signed);
  }
  if (!signatures.length) throw new Error("Connect the configured multisig signer wallets before approving.");
  const combined = args.multisig.publicKey.combinePartialSignatures(signatures.map(({ signature }) => signature));
  if (!(await args.multisig.publicKey.verifyPersonalMessage(args.message, combined))) {
    throw new Error("The combined wallet signatures do not meet this multisig's threshold for the approval intent.");
  }
  return combined;
}
