"use client";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { formatMyso, parseMyso, tipAmountProblem } from "./myso-coin-format";
import { ownerApi, useOwnerApprovalFlow } from "./myso-owner-approval-flow";

const ENDPOINT="/api/myso/post-tips";
interface Coin {coinObjectId:string;coinType:string;balanceBaseUnits:string}
const short=(id:string)=>id.length>14?`${id.slice(0,8)}…${id.slice(-4)}`:id;

/** Tip one post (payments.tip_post.v1, simple mode) from the owner wallet. */
export function MySoPostTip({ownerAddress,network}:{ownerAddress:string;network:string}){
    const approval=useOwnerApprovalFlow({endpoint:ENDPOINT,storageKey:`myso-agents:post-tip:${network}:${ownerAddress.toLowerCase()}`,ownerAddress,network,withAction:()=>({})});
    const [status,setStatus]=useState<{available:boolean;limitMist:string|null}|null>(null);const [statusError,setStatusError]=useState("");
    const [postId,setPostId]=useState("");const [amount,setAmount]=useState("");const [coins,setCoins]=useState<Coin[]|null>(null);const [coinId,setCoinId]=useState("");const [touched,setTouched]=useState(false);
    useEffect(()=>{
        let alive=true;
        void ownerApi<{available:boolean;limitMist:string|null}>(ENDPOINT,{operation:"status"}).then(async value=>{
            if(!alive)return;setStatus(value);
            if(value.available){const page=await ownerApi<{coins:Coin[]}>(ENDPOINT,{operation:"coins"});if(alive)setCoins(page.coins);}
        }).catch(reason=>{if(alive)setStatusError(reason instanceof Error?reason.message:"Post tips are unavailable");});
        return()=>{alive=false;};
    },[]);
    const available=status?.available===true;
    const problem=tipAmountProblem(amount,status?.limitMist??null);
    const mist=problem?null:parseMyso(amount);
    const postReady=/^0x[0-9a-fA-F]{1,64}$/.test(postId.trim());
    const locked=approval.busy||approval.pending||!available;
    return <section className="myso-create myso-post-tip" aria-labelledby="post-tip-title">
        <div className="myso-card-heading"><div><p className="myso-eyebrow">OWNER WALLET</p><h2 id="post-tip-title">Tip a post</h2></div></div>
        <p>Send MYSO to the creator of one post. Each tip is capped by your agent’s per-action spending limit.</p>
        {statusError?<p className="myso-knowledge-note" role="alert">{statusError}</p>:!status?<p className="myso-loading" role="status">Checking tip availability…</p>:!available?<p className="myso-knowledge-note">Post tips are unavailable to the connected agent’s current permissions.</p>:approval.walletControls}
        <label htmlFor="post-tip-id">Post ID</label>
        <input id="post-tip-id" autoComplete="off" spellCheck={false} maxLength={66} placeholder="0x…" value={postId} disabled={locked} onChange={event=>setPostId(event.target.value)}/>
        <label htmlFor="post-tip-amount">Amount</label>
        <div className="myso-amount-field"><input id="post-tip-amount" inputMode="decimal" autoComplete="off" placeholder="0.0" value={amount} disabled={locked} aria-describedby="post-tip-limit" aria-invalid={touched&&!!problem} onBlur={()=>setTouched(true)} onChange={event=>{setAmount(event.target.value);setCoinId("");}}/><span>MYSO</span></div>
        <small id="post-tip-limit" className="myso-field-hint">{status?.limitMist?`Limit: ${status.limitMist==="unlimited"?"no per-action limit":`${formatMyso(status.limitMist)} per action`}`:"Limit: checking…"}</small>
        {touched&&problem&&amount.trim()&&<p className="myso-knowledge-note" role="alert">{problem}</p>}
        {available&&mist&&(!coins?<p className="myso-loading" role="status">Loading wallet coins…</p>:coins.some(coin=>BigInt(coin.balanceBaseUnits)>=BigInt(mist))?<><label htmlFor="post-tip-coin">Pay from coin</label><select id="post-tip-coin" value={coinId} disabled={locked} onChange={event=>setCoinId(event.target.value)}><option value="">Choose a coin…</option>{coins.map(coin=><option key={coin.coinObjectId} value={coin.coinObjectId} disabled={BigInt(coin.balanceBaseUnits)<BigInt(mist)}>{short(coin.coinObjectId)} · {formatMyso(coin.balanceBaseUnits)}{BigInt(coin.balanceBaseUnits)<BigInt(mist)?" · not enough":""}</option>)}</select></>:<p className="myso-knowledge-note" role="alert">No single MYSO coin in the owner wallet covers {formatMyso(mist)}.</p>)}
        <button type="button" className="myso-primary" disabled={locked||!postReady||!mist||!coinId||!approval.ownerMatches} onClick={()=>{if(!mist)return;void approval.start("tip_post",`Tip ${formatMyso(mist)} to post ${short(postId.trim())}`,{postId:postId.trim(),paymentCoinId:coinId,amountBaseUnits:mist},()=>{setAmount("");setCoinId("");setTouched(false);setCoins(null);void ownerApi<{coins:Coin[]}>(ENDPOINT,{operation:"coins"}).then(page=>setCoins(page.coins)).catch(()=>setCoins([]));});}}>Review and sign<ArrowRight size={16}/></button>
        {approval.flowPanel}
    </section>;
}
