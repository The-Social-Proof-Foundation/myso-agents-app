/** MYSO base units (MIST) → "1.25 MYSO"; other coins show base units + type. */
export function isMysoCoin(coinType:string):boolean{return /^0x0*2::myso::MYSO$/i.test(coinType);}
export function formatMyso(baseUnits:string):string{
    const amount=BigInt(baseUnits), whole=amount/1_000_000_000n, fraction=(amount%1_000_000_000n).toString().padStart(9,"0").replace(/0+$/g,"");
    return `${whole.toString()}${fraction?`.${fraction}`:""} MYSO`;
}
export function formatCoin(baseUnits:string,coinType:string):string{
    return isMysoCoin(coinType)?formatMyso(baseUnits):`${baseUnits} base units · ${coinType.split("::").slice(-1)[0]??coinType}`;
}
/** "2.5" MYSO → "2500000000" MIST; null when not a valid amount (max 9 decimals). */
export function parseMyso(input:string):string|null{
    const match=/^(\d{1,11})(?:\.(\d{1,9}))?$/.exec(input.trim());
    if(!match)return null;
    return (BigInt(match[1]!)*1_000_000_000n+BigInt((match[2]??"").padEnd(9,"0")||"0")).toString();
}
export function formatDuration(ms:string):string{
    const days=Number(BigInt(ms)/86_400_000n);
    if(days>=1)return `${days} day${days===1?"":"s"}`;
    const hours=Number(BigInt(ms)/3_600_000n);
    return hours>=1?`${hours} hour${hours===1?"":"s"}`:`${Number(BigInt(ms)/60_000n)} minutes`;
}

/** Pure: why this tip can't be sent yet, or null when it can. The agent's
 *  per-action ceiling is the tip budget (no separate allowance object). */
export function tipAmountProblem(input:string,limitMist:string|null):string|null{
    if(!input.trim())return "Enter an amount.";
    const mist=parseMyso(input);
    if(mist===null)return "Use a number with up to 9 decimal places.";
    if(BigInt(mist)===0n)return "The tip must be more than zero.";
    if(limitMist!==null&&limitMist!=="unlimited"&&BigInt(mist)>BigInt(limitMist))return `This is above the agent’s ${formatMyso(limitMist)} per-action limit.`;
    return null;
}
