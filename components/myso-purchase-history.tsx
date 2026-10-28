"use client";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import type { MyDataOwnerAccessHistory, MyDataPurchaseHistory, MyDataPurchaseReceipt } from "@/src/core/contracts/mydata";
import { notifyMyDataGraphRevoked } from "@/src/core/mydata-disclosure";
import { MySoGraphAccessManager } from "./myso-graph-access-manager";

export function MySoPurchaseHistory({disabled,onInspect,onAccessRevoked,ownerAddress,agentAddress,network}:{disabled:boolean,onInspect:(mydataId:string)=>void;onAccessRevoked?:(mydataId:string)=>void;ownerAddress?:string;agentAddress?:string;network?:string}){
    const [history,setHistory]=useState<MyDataPurchaseHistory|null>(null);
    const [accessHistory,setAccessHistory]=useState<MyDataOwnerAccessHistory|null>(null);
    const [busy,setBusy]=useState(false);
    const [error,setError]=useState("");
    const [verifying,setVerifying]=useState("");
    const [receipts,setReceipts]=useState<Record<string,{status:string,checkpoint:string|null,receipt:MyDataPurchaseReceipt["receipts"][number]}>>({});
    const epoch=useRef(0);
    const scopeKey=`${network??""}:${ownerAddress?.toLowerCase()??""}:${agentAddress?.toLowerCase()??""}`;
    const currentScope=useRef(scopeKey);
    if(currentScope.current!==scopeKey){currentScope.current=scopeKey;epoch.current++;}
    useEffect(()=>{epoch.current++;setHistory(null);setAccessHistory(null);setReceipts({});setBusy(false);setError("");setVerifying("");},[scopeKey]);
    async function load(offset=0,append=false){
        const requestEpoch=epoch.current;
        setBusy(true);setError("");
        try{
            const response=await fetch("/api/myso/knowledge/purchases",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({limit:50,offset})});
            const result=await response.json();if(!response.ok)throw new Error(result.error??"Purchase history is unavailable");
            const page=result as MyDataPurchaseHistory;
            if(requestEpoch!==epoch.current)return;
            setHistory(previous=>append&&previous?{
                ...page,
                ownerPurchases:mergePurchaseRows(previous.ownerPurchases,page.ownerPurchases),
                agentPurchases:mergePurchaseRows(previous.agentPurchases,page.agentPurchases),
            }:page);
        }catch(reason){if(requestEpoch===epoch.current)setError(reason instanceof Error?reason.message:"Purchase history could not be loaded");}
        finally{if(requestEpoch===epoch.current)setBusy(false);}
    }
    async function verify(mydataId:string,digest:string){
        const requestEpoch=epoch.current;
        setVerifying(digest);setError("");
        try{
            const response=await fetch("/api/myso/knowledge/purchases/receipt",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({mydataId,digest})});
            const result=await response.json();if(!response.ok)throw new Error(result.error??"Purchase receipt could not be verified");
            if(requestEpoch===epoch.current)setReceipts(value=>({...value,[digest]:result as {status:string,checkpoint:string|null,receipt:MyDataPurchaseReceipt["receipts"][number]}}));
        }catch(reason){if(requestEpoch===epoch.current)setError(reason instanceof Error?reason.message:"Purchase receipt could not be verified");}
        finally{if(requestEpoch===epoch.current)setVerifying("");}
    }
    async function loadAccessHistory(offset=0,append=false){
        const requestEpoch=epoch.current;
        setBusy(true);setError("");
        try{
            const response=await fetch("/api/myso/knowledge/purchases/lifecycle",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({limit:50,offset})});
            const result=await response.json();if(!response.ok)throw new Error(result.error??"Grant and revocation history is unavailable");
            const page=result as MyDataOwnerAccessHistory;
            if(requestEpoch===epoch.current)setAccessHistory(previous=>append&&previous?{...page,entries:mergeAccessRows(previous.entries,page.entries)}:page);
        }catch(reason){if(requestEpoch===epoch.current)setError(reason instanceof Error?reason.message:"Grant and revocation history could not be loaded");}
        finally{if(requestEpoch===epoch.current)setBusy(false);}
    }
    const rows=history?[...history.ownerPurchases.map(item=>({...item,purchaseWallet:"Owner wallet"})),...history.agentPurchases.map(item=>({...item,purchaseWallet:"Agent wallet"}))].sort((a,b)=>b.purchase_time-a.purchase_time):[];
    return <section className="myso-purchase-history" aria-label="MyData purchase history" aria-busy={busy}>
        <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={disabled||busy} onClick={()=>void load()}><RefreshCw size={15}/>{busy?"Loading purchase history…":history?"Refresh purchase history":"Load my purchase history"}</button><button type="button" className="myso-secondary" disabled={disabled||busy} onClick={()=>void loadAccessHistory()}>{busy?"Loading access history…":accessHistory?"Refresh access history":"Load owner grant/revocation history"}</button></div>
        {error&&<p role="alert" className="myso-error">{error}</p>}
        {history&&<div className="myso-listing-results">
            <p className="myso-knowledge-note">{history.notice} This view combines your owner wallet ({history.ownerAddress}) and this agent wallet ({history.agentAddress}); purchases remain separate by signer.</p>
            {graphGroups(rows,receipts)}
            {rows.length===0?<p className="myso-knowledge-note">No indexed purchases were found for these wallets.</p>:rows.map((item,index)=><article className="myso-listing-card" key={`${item.transaction_id}:${item.id}:${index}`}>
                <div><strong>{item.purchaseWallet} · {item.purchase_type}</strong><p>{item.revoked?"Index reports access revoked":"Index reports purchase recorded"} · {new Date(item.purchase_time).toLocaleString()}</p><small>Listing {item.mydata_id} · transaction {item.transaction_id}</small></div>
                <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={disabled||busy||!!verifying} onClick={()=>onInspect(item.mydata_id)}>Inspect current listing<ArrowRight size={15}/></button><button type="button" className="myso-secondary" disabled={disabled||busy||!!verifying||!!receipts[item.transaction_id]} onClick={()=>void verify(item.mydata_id,item.transaction_id)}>{verifying===item.transaction_id?"Checking fullnode…":receipts[item.transaction_id]?`Receipt ${receipts[item.transaction_id]!.status}`:"Verify chain receipt"}</button></div>
                {receipts[item.transaction_id]&&<><p className="myso-knowledge-note" role="status">Fullnode confirms the matching purchase event · {receipts[item.transaction_id]!.status}{receipts[item.transaction_id]!.checkpoint?` · ${receipts[item.transaction_id]!.checkpoint}`:""} · {receipts[item.transaction_id]!.receipt.buyerExecution=== "owner_approved"?"owner-wallet purchase":"agent-funded purchase"}{receipts[item.transaction_id]!.receipt.organizationAudienceId?` · organization audience ${receipts[item.transaction_id]!.receipt.organizationAudienceId}`:""}. Current key access is checked separately.</p>{!receipts[item.transaction_id]!.receipt.graphSnapshot&&receipts[item.transaction_id]!.receipt.buyerAgentId===null&&receipts[item.transaction_id]!.receipt.organizationAudienceId===null&&<p className="myso-knowledge-note">Legacy address-only purchase. It keeps its original audience rule and is not treated as an agent or organization binding.</p>}{receipts[item.transaction_id]!.receipt.graphSnapshot&&<p className="myso-knowledge-note">Immutable graph purchase snapshot · {receipts[item.transaction_id]!.receipt.graphSnapshot!.graphId} v{receipts[item.transaction_id]!.receipt.graphSnapshot!.graphVersion} · manifest SHA-256 {receipts[item.transaction_id]!.receipt.graphSnapshot!.manifestHashHex} · seller signature SHA-256 {receipts[item.transaction_id]!.receipt.graphSnapshot!.publicationSignatureDigestHex}</p>}{ownerAddress&&network&&accessHistory&&activeAgentGrant(accessHistory,receipts[item.transaction_id]!.receipt.mydataId,receipts[item.transaction_id]!.receipt.accessKind)&&receipts[item.transaction_id]!.receipt.buyerExecution==="owner_approved"&&receipts[item.transaction_id]!.receipt.buyerAgentId===null&&receipts[item.transaction_id]!.receipt.organizationAudienceId===null&&receipts[item.transaction_id]!.receipt.graphSnapshot&&<MySoGraphAccessManager mydataId={receipts[item.transaction_id]!.receipt.mydataId} accessKind={receipts[item.transaction_id]!.receipt.accessKind} ownerAddress={ownerAddress} agentAddress={accessHistory.agentAddress} network={network} onRevoked={()=>{const receipt=receipts[item.transaction_id]!.receipt;void loadAccessHistory();if(ownerAddress&&accessHistory?.agentAddress&&network)notifyMyDataGraphRevoked({mydataId:receipt.mydataId,ownerAddress,agentAddress:accessHistory.agentAddress,network});onAccessRevoked?.(receipt.mydataId);}}/>}</>}
            </article>)}
            {history.hasMore&&history.nextOffset!==null&&<button type="button" className="myso-secondary" disabled={disabled||busy} onClick={()=>{const nextOffset=history.nextOffset;if(nextOffset!==null)void load(nextOffset,true);}}>{busy?"Loading older purchases…":"Load older purchases"}</button>}
        </div>}
        {accessHistory&&<div className="myso-listing-results" aria-label="Owner access lifecycle">
            <p className="myso-knowledge-note">{accessHistory.notice} Entries come from this account/agent's persisted action journal. Current access is rechecked by the live MyData key policy when reading.</p>
            {(()=>{const events=accessHistory.entries.flatMap(entry=>(entry.chainReceipt?.events??[]).filter(event=>sameAddress(event.recipient,accessHistory.agentAddress)).map(event=>({event,receipt:entry.chainReceipt!,action:entry.registryAction}))).sort((a,b)=>BigInt(a.event.timestampMs)>BigInt(b.event.timestampMs)?-1:BigInt(a.event.timestampMs)<BigInt(b.event.timestampMs)?1:0);return events.length===0?<p className="myso-knowledge-note">No owner grant or revocation events for this agent were found on the first history page.</p>:events.map(({event,receipt,action},index)=><article className="myso-listing-card" key={`${receipt.digest}:${event.mydataId}:${index}`}>
                <div><strong>{event.kind==="AccessGrantedEvent"?"Owner granted access":"Owner revoked access"} · {event.accessType}</strong><p>Listing {event.mydataId} · {receipt.status}{receipt.checkpoint?` · checkpoint ${receipt.checkpoint}`:""}</p><small>{new Date(Number(event.timestampMs)).toLocaleString()} · transaction {receipt.digest} · {action}</small></div>
            </article>);})()}
            {accessHistory.hasMore&&accessHistory.offset<100000&&<button type="button" className="myso-secondary" disabled={disabled||busy} onClick={()=>void loadAccessHistory(Math.min(100000,accessHistory.offset+accessHistory.limit),true)}>{busy?"Loading older access history…":"Load older grant/revocation records"}</button>}
            {accessHistory.hasMore&&accessHistory.offset>=100000&&<p className="myso-knowledge-note">The 100,000-record offset limit has been reached; older journal entries cannot be paged through this interface.</p>}
        </div>}
    </section>;
}

function graphGroups(rows:Array<{transaction_id:string}>,receipts:Record<string,{receipt:MyDataPurchaseReceipt["receipts"][number]}>){
    const groups=new Map<string,string[]>();
    for(const item of rows){
        const snapshot=receipts[item.transaction_id]?.receipt.graphSnapshot;
        if(!snapshot)continue;
        const versions=groups.get(snapshot.graphId)??[];
        if(!versions.includes(snapshot.graphVersion))versions.push(snapshot.graphVersion);
        groups.set(snapshot.graphId,versions);
    }
    if(groups.size===0)return null;
    return <div className="myso-knowledge-note">{[...groups].map(([graphId,versions])=><p key={graphId}>Graph {graphId} · {versions.map(version=>`version ${version}`).join(" · ")}. Each version remains a separate purchase.</p>)}</div>;
}

function sameAddress(a:string,b:string){return a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");}

function activeAgentGrant(history:MyDataOwnerAccessHistory,mydataId:string,accessKind:2|3):boolean{
    const expected=accessKind===2?"one_time":"subscription";
    const events=history.entries.flatMap(entry=>(entry.chainReceipt?.events??[]).filter(event=>sameAddress(event.mydataId,mydataId)&&sameAddress(event.recipient,history.agentAddress)&&(event.accessType===expected||event.accessType==="all")).map(event=>({event,receipt:entry.chainReceipt!})))
        .sort((a,b)=>BigInt(a.event.timestampMs)>BigInt(b.event.timestampMs)?-1:BigInt(a.event.timestampMs)<BigInt(b.event.timestampMs)?1:0);
    if(!events[0]||events[0].receipt.status!=="finalized")return false;
    if(events[1]&&events[0].event.timestampMs===events[1].event.timestampMs&&events[0].event.kind!==events[1].event.kind)return false;
    return events[0].event.kind==="AccessGrantedEvent";
}

function mergePurchaseRows<T extends {id:number}>(older:T[],newer:T[]):T[]{
    const rows=new Map<number,T>();
    for(const row of [...older,...newer])rows.set(row.id,row);
    return [...rows.values()];
}

function mergeAccessRows<T extends {registryAction:string,digest:string|null,createdAt:string}>(older:T[],newer:T[]):T[]{
    const rows=new Map<string,T>();
    for(const row of [...older,...newer])rows.set(`${row.registryAction}:${row.digest??row.createdAt}`,row);
    return [...rows.values()];
}
