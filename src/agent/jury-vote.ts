export interface JuryCommitmentInput {
    caseId: string;
    round: number | bigint | string;
    agentId: string;
    outcome: number;
    rationaleDigestHex: string;
    evidenceRefs: readonly (number | bigint | string)[];
    bundleDigestHex: string;
    saltHex: string;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
    const length = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

const MASK_64=(1n<<64n)-1n;
const ROTATION=[[0,36,3,41,18],[1,44,10,45,2],[62,6,43,15,61],[28,55,25,21,56],[27,20,39,8,14]] as const;
const ROUND_CONSTANTS=[
    0x0000000000000001n,0x0000000000008082n,0x800000000000808an,0x8000000080008000n,
    0x000000000000808bn,0x0000000080000001n,0x8000000080008081n,0x8000000000008009n,
    0x000000000000008an,0x0000000000000088n,0x0000000080008009n,0x000000008000000an,
    0x000000008000808bn,0x800000000000008bn,0x8000000000008089n,0x8000000000008003n,
    0x8000000000008002n,0x8000000000000080n,0x000000000000800an,0x800000008000000an,
    0x8000000080008081n,0x8000000000008080n,0x0000000080000001n,0x8000000080008008n,
];
function rotate64(value:bigint,shift:number):bigint{return shift===0?value:((value<<BigInt(shift))|(value>>BigInt(64-shift)))&MASK_64;}
function keccakF(state:bigint[]):void{
    for(const rc of ROUND_CONSTANTS){
        const columns=Array<bigint>(5).fill(0n);for(let x=0;x<5;x++)for(let y=0;y<5;y++)columns[x]=columns[x]!^state[x+5*y]!;
        const delta=columns.map((_,x)=>columns[(x+4)%5]!^rotate64(columns[(x+1)%5]!,1));
        for(let x=0;x<5;x++)for(let y=0;y<5;y++)state[x+5*y]=(state[x+5*y]!^delta[x]!)&MASK_64;
        const moved=Array<bigint>(25).fill(0n);
        for(let x=0;x<5;x++)for(let y=0;y<5;y++)moved[y+5*((2*x+3*y)%5)]=rotate64(state[x+5*y]!,ROTATION[x]![y]!);
        for(let x=0;x<5;x++)for(let y=0;y<5;y++)state[x+5*y]=(moved[x+5*y]!^((~moved[(x+1)%5+5*y]!)&moved[(x+2)%5+5*y]!))&MASK_64;
        state[0]=(state[0]!^rc)&MASK_64;
    }
}
function sha3_256(input:Uint8Array):Uint8Array{
    const rate=136;const paddedLength=Math.ceil((input.length+1)/rate)*rate;const padded=new Uint8Array(paddedLength);padded.set(input);padded[input.length]=0x06;padded[padded.length-1]=padded[padded.length-1]!|0x80;
    const state=Array<bigint>(25).fill(0n);
    for(let offset=0;offset<padded.length;offset+=rate){
        for(let index=0;index<rate;index++){const lane=Math.floor(index/8);state[lane]=state[lane]!^(BigInt(padded[offset+index]!)<<BigInt((index%8)*8));}
        keccakF(state);
    }
    const digest=new Uint8Array(32);for(let index=0;index<digest.length;index++)digest[index]=Number((state[Math.floor(index/8)]!>>BigInt((index%8)*8))&0xffn);return digest;
}

function fromHex(value: string, label: string, expectedLength?: number): Uint8Array {
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError(`${label} must be an even-length hex string`);
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < bytes.length; index++) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (expectedLength !== undefined && bytes.length !== expectedLength) throw new TypeError(`${label} must be ${expectedLength} bytes`);
    return bytes;
}

/** BCS encoding of a Move ID/address (a 32-byte value, left-padded). */
function bcsId(value: string): Uint8Array {
    const hex = value.trim().replace(/^0x/i, "").toLowerCase();
    if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new TypeError("Jury case and agent IDs must be 1–64 hexadecimal digits");
    return fromHex(hex.padStart(64, "0"), "ID", 32);
}

function bcsU64(value: number | bigint | string): Uint8Array {
    let integer: bigint;
    try { integer = BigInt(value); } catch { throw new TypeError("Jury round and evidence references must be integers"); }
    if (integer < 0n || integer > 0xffff_ffff_ffff_ffffn) throw new RangeError("Jury round or evidence reference is outside u64 range");
    const result = new Uint8Array(8);
    for (let index = 0; index < result.length; index++) result[index] = Number((integer >> BigInt(index * 8)) & 0xffn);
    return result;
}

function uleb128(value: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Invalid BCS vector length");
    const result: number[] = [];
    let remaining = value;
    do {
        let byte = remaining & 0x7f;
        remaining = Math.floor(remaining / 128);
        if (remaining) byte |= 0x80;
        result.push(byte);
    } while (remaining);
    return new Uint8Array(result);
}

function bcsU64Vector(values: readonly (number | bigint | string)[]): Uint8Array {
    return concat([uleb128(values.length), ...values.map(bcsU64)]);
}

/** SHA3-256 commitment, byte-for-byte compatible with `jury::compute_commitment`. */
export function computeJuryCommitment(input: JuryCommitmentInput): string {
    if (!Number.isInteger(input.outcome) || input.outcome < 0 || input.outcome > 255) throw new RangeError("Jury outcome must fit u8");
    const preimage = concat([
        bcsId(input.caseId), bcsU64(input.round), bcsId(input.agentId), new Uint8Array([input.outcome]),
        fromHex(input.rationaleDigestHex, "Rationale digest", 32), bcsU64Vector(input.evidenceRefs),
        fromHex(input.bundleDigestHex, "Bundle digest", 32), fromHex(input.saltHex, "Vote salt"),
    ]);
    const saltBytes = input.saltHex.length / 2;
    if (saltBytes < 16 || saltBytes > 64) throw new TypeError("Vote salt must be 16–64 bytes");
    return bytesToHex(sha3_256(preimage));
}

/** SHA-256 text digest used by the jury runner for rationale and canonical bundles. */
export async function jurySha256Hex(value: string | Uint8Array): Promise<string> {
    const bytes=typeof value==="string"?new TextEncoder().encode(value):value;
    const digest=await globalThis.crypto.subtle.digest("SHA-256",bytes.slice().buffer as ArrayBuffer);
    return bytesToHex(new Uint8Array(digest));
}

/** Same sorted-key canonical JSON form used for the jury runner's public case bundle. */
export function juryCanonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
    if (Array.isArray(value)) return `[${value.map(juryCanonicalJson).join(",")}]`;
    return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${juryCanonicalJson(item)}`).join(",")}}`;
}

export function createJuryVoteSalt(): string {
    const bytes = new Uint8Array(32);
    globalThis.crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}
