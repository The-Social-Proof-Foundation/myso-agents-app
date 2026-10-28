"use client";
import { useEffect, useState } from "react";
import { useConnectWallet, useCurrentAccount, useCurrentWallet, useSignPersonalMessage, useSignTransaction, useWallets } from "@socialproof/dapp-kit";
import { Wallet } from "lucide-react";

type Phase="requested"|"approved"|"prepared"|"submitted"|"finalized";
/** One owner-approved registry action in flight. Persisted per tab so a
 *  reload resumes the exact approval instead of creating a second one. */
export interface OwnerFlow {action:string;label:string;idempotencyKey:string;approvalId:string;approvalIntent:string;parameters:Record<string,unknown>;phase:Phase;digest?:string}
export interface OwnerReceipt {digest:string;registryAction:string;status:"finalized"|"executed"|"failed"|"unknown";[key:string]:unknown}
interface ApprovalResponse {approvalId:string;approvalIntent:string;registryAction:string;parameters:Record<string,unknown>;idempotencyKey:string}
interface PreparedResponse {approvalId:string;registryAction:string;bytes:string;digest:string;idempotencyKey:string}

const same=(a:string,b:string)=>a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
export async function ownerApi<T>(endpoint:string,input:Record<string,unknown>):Promise<T>{
    const response=await fetch(endpoint,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
    const result=await response.json() as {error?:string};if(!response.ok)throw new Error(result.error??"This owner action could not continue");return result as T;
}
function isFlow(value:unknown):value is OwnerFlow{
    if(!value||typeof value!=="object")return false;const v=value as Partial<OwnerFlow>;
    return typeof v.action==="string"&&typeof v.label==="string"&&typeof v.idempotencyKey==="string"&&typeof v.approvalId==="string"&&typeof v.approvalIntent==="string"&&!!v.parameters&&typeof v.parameters==="object"&&["requested","approved","prepared","submitted","finalized"].includes(v.phase??"");
}
const STATUS_MESSAGE:Record<OwnerReceipt["status"],string>={
    finalized:"Finalized on chain. The receipt confirms this exact transaction.",
    executed:"The transaction executed, but the fullnode has not reported a checkpoint yet. Check again before relying on it.",
    failed:"The transaction failed on chain. Nothing was changed.",
    unknown:"No receipt is available yet. Check again after the chain indexes the transaction.",
};

/** Shared owner-wallet approval path: sign the exact intent → approve →
 *  prepare against live state → sign the transaction → submit → receipt.
 *  `withAction` adds route-specific fields (e.g. the subscription action). */
export function useOwnerApprovalFlow({endpoint,storageKey,ownerAddress,network,withAction}:{endpoint:string;storageKey:string;ownerAddress:string;network:string;withAction:(action:string)=>Record<string,unknown>}){
    const wallets=useWallets();const account=useCurrentAccount();const {currentWallet}=useCurrentWallet();const connect=useConnectWallet();const signMessage=useSignPersonalMessage();const signTransaction=useSignTransaction();
    const [flow,setFlow]=useState<OwnerFlow|null>(null);const [receipt,setReceipt]=useState<OwnerReceipt|null>(null);
    const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");const [hydrated,setHydrated]=useState(false);
    const ownerMatches=!!account&&same(account.address,ownerAddress)&&!!currentWallet;
    const chain=`myso:${network}` as `${string}:${string}`;
    useEffect(()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw){const parsed=JSON.parse(raw) as unknown;if(isFlow(parsed))setFlow(parsed);}}catch{}finally{setHydrated(true);}},[storageKey]);
    useEffect(()=>{if(!hydrated)return;try{if(flow)sessionStorage.setItem(storageKey,JSON.stringify(flow));else sessionStorage.removeItem(storageKey);}catch{}},[flow,hydrated,storageKey]);
    async function readReceipt(target:OwnerFlow){
        const value=await ownerApi<OwnerReceipt>(endpoint,{operation:"receipt",digest:target.digest,...withAction(target.action)});
        if(value.digest!==target.digest)throw new Error("The receipt did not match this transaction");
        setReceipt(value);setMessage(STATUS_MESSAGE[value.status]);
        if(value.status==="finalized")setFlow({...target,phase:"finalized"});
        return value;
    }
    async function continueFlow(target:OwnerFlow,onFinalized?:()=>void){
        if(!ownerMatches){setMessage("Connect the owner wallet for this MySo account before signing.");return;}
        setBusy(true);setMessage("");let current=target;
        try{
            if(current.phase==="requested"){
                setMessage("Sign the exact approval intent in your owner wallet…");
                const signature=await signMessage.mutateAsync({message:new TextEncoder().encode(current.approvalIntent),chain});
                await ownerApi(endpoint,{operation:"approve",approvalId:current.approvalId,walletSignature:signature.signature});
                current={...current,phase:"approved"};setFlow(current);
            }
            if(current.phase==="approved"||current.phase==="prepared"){
                setMessage("Preparing the approved transaction against the latest on-chain state…");
                const prepared=await ownerApi<PreparedResponse>(endpoint,{operation:"prepare",idempotencyKey:current.idempotencyKey,approvalId:current.approvalId,parameters:current.parameters,...withAction(current.action)});
                if(prepared.approvalId!==current.approvalId||prepared.idempotencyKey!==current.idempotencyKey||current.digest&&prepared.digest!==current.digest)throw new Error("The prepared transaction did not match the approved action");
                current={...current,phase:"prepared",digest:prepared.digest};setFlow(current);
                setMessage("Review the exact transaction in your wallet…");
                const signed=await signTransaction.mutateAsync({transaction:prepared.bytes,chain});
                await ownerApi(endpoint,{operation:"submit",idempotencyKey:current.idempotencyKey,approvalId:current.approvalId,digest:prepared.digest,walletSignature:signed.signature,...withAction(current.action)});
                current={...current,phase:"submitted"};setFlow(current);setMessage("Submitted. Checking the receipt…");
            }
            if(current.phase==="submitted"&&current.digest){const value=await readReceipt(current);if(value.status==="finalized")onFinalized?.();}
        }catch(error){
            setMessage(error instanceof Error?error.message:"The approval could not finish");
            if(current.digest&&current.phase==="submitted"){try{await readReceipt(current);}catch{/* Keep the exact digest for a later check. */}}
        }finally{setBusy(false);}
    }
    /** Create the exact approval request, then walk the owner through signing. */
    async function start(action:string,label:string,body:Record<string,unknown>,onFinalized?:()=>void){
        if(!hydrated){setMessage("Restoring any pending owner approval first…");return;}
        if(!ownerMatches){setMessage("Connect the owner wallet for this MySo account first.");return;}
        if(flow&&flow.phase!=="finalized"){setMessage("Finish or dismiss the pending approval first.");return;}
        setBusy(true);setReceipt(null);setMessage("Requesting owner approval for this exact action…");
        const idempotencyKey=`${action}:${crypto.randomUUID()}`;
        try{
            const approval=await ownerApi<ApprovalResponse>(endpoint,{operation:"request",idempotencyKey,...withAction(action),...body});
            if(!approval.approvalId||!approval.approvalIntent||approval.idempotencyKey!==idempotencyKey)throw new Error("The approval request did not match this action");
            const next:OwnerFlow={action,label,idempotencyKey,approvalId:approval.approvalId,approvalIntent:approval.approvalIntent,parameters:approval.parameters,phase:"requested"};
            setFlow(next);setBusy(false);
            await continueFlow(next,onFinalized);
        }catch(error){setMessage(error instanceof Error?error.message:"The approval request could not be created");setBusy(false);}
    }
    function dismiss(){setFlow(null);setReceipt(null);setMessage("");}
    const pending=!!flow&&flow.phase!=="finalized";
    const walletControls=ownerMatches?<p className="myso-policy-wallet"><Wallet size={14}/> Owner wallet connected · {account!.address}</p>:<div className="myso-toolbar">{account&&<p className="myso-knowledge-note">Connected wallet {account.address} does not match this account owner.</p>}{wallets.map(wallet=><button key={wallet.name} type="button" className="myso-secondary" disabled={connect.isPending||busy} onClick={()=>void connect.mutateAsync({wallet,accountAddress:ownerAddress}).catch(error=>setMessage(error instanceof Error?error.message:"Wallet connection failed"))}><Wallet size={15}/>{connect.isPending?"Connecting…":`Connect ${wallet.name}`}</button>)}</div>;
    const flowPanel=flow?<div className="myso-agent-policy-pending" aria-live="polite">
        <div><p className="myso-eyebrow">OWNER APPROVAL · {flow.phase.toUpperCase()}</p><strong>{flow.label}</strong><small>Approval {flow.approvalId}</small>{flow.digest&&<small>Transaction {flow.digest}</small>}</div>
        <details><summary>Review signed intent</summary><pre>{flow.approvalIntent}</pre></details>
        {receipt&&<div className="myso-verified-receipt" role="status"><strong>{receipt.status==="finalized"?"Finalized receipt verified":`Receipt status: ${receipt.status}`}</strong><span>Transaction {receipt.digest}</span></div>}
        <div className="myso-toolbar">
            {flow.phase!=="finalized"&&flow.phase!=="submitted"&&<button type="button" className="myso-primary" disabled={busy||!ownerMatches} onClick={()=>void continueFlow(flow)}>{busy?"Waiting for wallet…":flow.phase==="requested"?"Sign and continue":"Sign transaction"}</button>}
            {flow.phase==="submitted"&&<button type="button" className="myso-secondary" disabled={busy} onClick={()=>void continueFlow(flow)}>{busy?"Checking…":"Check receipt again"}</button>}
            {(flow.phase!=="submitted"||receipt?.status==="failed")&&<button type="button" className="myso-text-button" disabled={busy} onClick={dismiss}>{flow.phase==="finalized"?"Done":"Dismiss"}</button>}
        </div>
        {message&&<p className="myso-knowledge-note" role="status">{message}</p>}
    </div>:message?<p className="myso-knowledge-note" role="status">{message}</p>:null;
    return {flow,receipt,busy,pending,ownerMatches,start,walletControls,flowPanel,setMessage};
}
