"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnectWallet, useCurrentAccount, useCurrentWallet, useSignPersonalMessage, useSignTransaction, useWallets } from "@socialproof/dapp-kit";
import { ArrowRight, Check, Wallet } from "lucide-react";
import type { AuthorityQuote } from "./myso-agent-authority";

type PolicyAction="revoke"|"grant_capability"|"revoke_capability"|"raise_spending_limit"|"lower_spending_limit";
type PolicyPhase="requested"|"approved"|"prepared"|"submitted"|"finalized";
interface Flow {agentObjectId:string;action:PolicyAction;idempotencyKey:string;capabilityMask?:string;newLimitMist?:string;confirmed?:true;approvalId:string;approvalIntent:string;phase:PolicyPhase;digest?:string}
interface ApprovalResponse {approvalId:string;approvalIntent:string;expiresAtMs?:number;registryAction:string;parameters:Record<string,unknown>;idempotencyKey:string}
interface PreparedResponse {approvalId:string;registryAction:string;bytes:string;digest:string;idempotencyKey:string}
interface PolicyReceipt {digest:string;registryAction:string;status:"finalized"|"executed"|"failed"|"unknown";evidence:unknown[];evidenceSource:string}
const capabilityOptions=[
    [0n,"Memory read"],[1n,"Memory write"],[2n,"MyData read"],[4n,"Publish posts"],[5n,"Read messages"],[6n,"Send messages"],[7n,"Monitor trades"],[8n,"Execute trades"],[9n,"Comment"],[10n,"React"],[11n,"Revoke child agents"],[12n,"Update child agents"],[13n,"Register child agents"],[14n,"Spend AI credits"],[15n,"Manage budgets"],[16n,"Social graph"],[17n,"Task marketplace"],[18n,"Jury"],
] as const;
async function policyApi<T>(input:Record<string,unknown>):Promise<T>{
    const response=await fetch("/api/myso/agent-policy",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(input)});
    const result=await response.json() as {error?:string};if(!response.ok)throw new Error(result.error??"Agent policy change could not continue");return result as T;
}
const same=(a:string,b:string)=>a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
function isFlow(value:unknown,agentId:string):value is Flow{
    if(!value||typeof value!=="object")return false;const v=value as Partial<Flow>;
    return v.agentObjectId===agentId&&["revoke","grant_capability","revoke_capability","raise_spending_limit","lower_spending_limit"].includes(v.action??"")&&typeof v.idempotencyKey==="string"&&typeof v.approvalId==="string"&&typeof v.approvalIntent==="string"&&["requested","approved","prepared","submitted","finalized"].includes(v.phase??"");
}
function description(flow:Flow){
    if(flow.action==="revoke")return `Permanently revoke agent ${flow.agentObjectId}`;
    if(flow.action==="raise_spending_limit")return `Raise this agent's per-action ceiling to ${flow.newLimitMist==="unlimited"?"unlimited":`${flow.newLimitMist} MIST`}`;
    if(flow.action==="lower_spending_limit")return `Lower this agent's per-action ceiling to ${flow.newLimitMist} MIST`;
    return `${flow.action==="grant_capability"?"Grant":"Remove"} capability mask ${flow.capabilityMask} for ${flow.agentObjectId}`;
}

export function MySoAgentPolicyControls({quote,ownerAddress,network,onComplete}:{quote:AuthorityQuote;ownerAddress:string;network:string;onComplete:()=>void}){
    const wallets=useWallets();const account=useCurrentAccount();const {currentWallet}=useCurrentWallet();const connect=useConnectWallet();const signMessage=useSignPersonalMessage();const signTransaction=useSignTransaction();
    const [selectedCapabilities,setSelectedCapabilities]=useState(quote.agent.expectedCapabilities);
    const [newLimitMist,setNewLimitMist]=useState("");const [unlimited,setUnlimited]=useState(false);const [flow,setFlow]=useState<Flow|null>(null);const [receipt,setReceipt]=useState<PolicyReceipt|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");const [hydrated,setHydrated]=useState(false);
    const storageKey=`myso-agents:agent-policy:${network}:${ownerAddress.toLowerCase()}:${quote.agent.agentObjectId.toLowerCase()}`;
    const current=BigInt(quote.agent.expectedCapabilities);const selected=BigInt(selectedCapabilities);const supported=BigInt(quote.supportedGrantMask);
    const grantMask=(selected&~current)&supported;const revokeMask=(current&~selected)&supported;
    const ownerMatches=!!account&&same(account.address,ownerAddress)&&!!currentWallet;
    const chain=`myso:${network}` as `${string}:${string}`;
    useEffect(()=>{setSelectedCapabilities(quote.agent.expectedCapabilities);},[quote.agent.agentObjectId,quote.agent.expectedCapabilities]);
    useEffect(()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw){const parsed=JSON.parse(raw) as unknown;if(isFlow(parsed,quote.agent.agentObjectId))setFlow(parsed);}}catch{}finally{setHydrated(true);}},[storageKey,quote.agent.agentObjectId]);
    useEffect(()=>{if(!hydrated)return;if(flow)sessionStorage.setItem(storageKey,JSON.stringify(flow));else sessionStorage.removeItem(storageKey);},[flow,hydrated,storageKey]);
    const actionLabel=useMemo(()=>flow?description(flow):"",[flow]);
    async function readReceipt(target:Flow){
        const value=await policyApi<PolicyReceipt>({operation:"receipt",digest:target.digest,action:target.action});
        if(value.digest!==target.digest)throw new Error("The receipt did not match this policy transaction");
        setReceipt(value);
        if(value.status==="finalized"){const done={...target,phase:"finalized" as const};setFlow(done);setMessage("The finalized owner-policy event is verified. Refresh the live snapshot before making another change.");}
        else if(value.status==="executed")setMessage("The policy event is present, but the fullnode has not reported a checkpoint yet. Check again before relying on finality.");
        else if(value.status==="failed")setMessage("The transaction failed on chain. The requested policy change did not finalize.");
        else setMessage("No finalized policy receipt is available yet. Check again after the chain indexes the transaction.");
    }
    async function continueFlow(target:Flow){
        if(!ownerMatches){setMessage("Connect the owner wallet for this MySo account before signing.");return;}
        setBusy(true);setMessage("");
        let currentFlow=target;
        try{
            if(currentFlow.phase==="requested"){
                setMessage("Sign the exact policy approval intent in your owner wallet…");
                const signature=await signMessage.mutateAsync({message:new TextEncoder().encode(currentFlow.approvalIntent),chain});
                await policyApi({operation:"approve",approvalId:currentFlow.approvalId,walletSignature:signature.signature});
                currentFlow={...currentFlow,phase:"approved"};setFlow(currentFlow);
            }
            if(currentFlow.phase==="approved"||currentFlow.phase==="prepared"){
                setMessage("Preparing the approved policy change against the latest on-chain state…");
                const prepared=await policyApi<PreparedResponse>({operation:"prepare",agentObjectId:currentFlow.agentObjectId,action:currentFlow.action,idempotencyKey:currentFlow.idempotencyKey,approvalId:currentFlow.approvalId,...(currentFlow.capabilityMask?{capabilityMask:currentFlow.capabilityMask}:{}),...(currentFlow.newLimitMist?{newLimitMist:currentFlow.newLimitMist}:{}),...(currentFlow.confirmed?{confirmed:true}:{})});
                if(prepared.approvalId!==currentFlow.approvalId||prepared.idempotencyKey!==currentFlow.idempotencyKey||prepared.registryAction!==({revoke:"agent.revoke_agent.v1",grant_capability:"agent.grant_capability.v1",revoke_capability:"agent.revoke_capability.v1",raise_spending_limit:"agent.raise_spending_limit.v1",lower_spending_limit:"agent.lower_spending_limit.v1"} as const)[currentFlow.action]||(currentFlow.digest&&prepared.digest!==currentFlow.digest))throw new Error("The prepared transaction did not match the approved agent policy change");
                currentFlow={...currentFlow,phase:"prepared",digest:prepared.digest};setFlow(currentFlow);
                setMessage("Review the exact owner-signed transaction in your wallet…");
                const signed=await signTransaction.mutateAsync({transaction:prepared.bytes,chain});
                await policyApi({operation:"submit",action:currentFlow.action,idempotencyKey:currentFlow.idempotencyKey,approvalId:currentFlow.approvalId,digest:prepared.digest,walletSignature:signed.signature});
                currentFlow={...currentFlow,phase:"submitted",digest:prepared.digest};setFlow(currentFlow);setMessage("Submitted. Checking the fullnode policy receipt…");
                await readReceipt(currentFlow);
            }else if(currentFlow.phase==="submitted"&&currentFlow.digest){
                setMessage("Checking the fullnode policy receipt…");await readReceipt(currentFlow);
            }else if(currentFlow.phase==="finalized"){
                setMessage("This owner-policy change is finalized and verified.");
            }
        }catch(error){
            const text=error instanceof Error?error.message:"The policy approval could not finish";setMessage(text);
            if(currentFlow.digest){try{await readReceipt(currentFlow);}catch{/* Keep the exact pending digest for a later retry. */}}
        }finally{setBusy(false);}
    }
    async function request(action:PolicyAction,params:{capabilityMask?:string;newLimitMist?:string;confirmed?:true}={}){
        if(!hydrated){setMessage("Restoring any pending owner approval first…");return;}
        if(!ownerMatches){setMessage("Connect the owner wallet for this MySo account before requesting a policy change.");return;}
        if(action==="revoke"&&!window.confirm("Revoking an agent permanently removes it on chain and cannot be undone. Continue only if this is the intended agent."))return;
        setBusy(true);setMessage("Requesting owner approval for this exact policy change…");setReceipt(null);
        const idempotencyKey=`agent-policy:${crypto.randomUUID()}`;
        try{
            const approval=await policyApi<ApprovalResponse>({operation:"request",agentObjectId:quote.agent.agentObjectId,action,idempotencyKey,...params});
            if(!approval.approvalId||!approval.approvalIntent||approval.idempotencyKey!==idempotencyKey)throw new Error("The approval request did not match the selected policy change");
            const next:Flow={agentObjectId:quote.agent.agentObjectId,action,idempotencyKey,approvalId:approval.approvalId,approvalIntent:approval.approvalIntent,phase:"requested",...params};
            setFlow(next);setMessage("Approval intent created. Continue to sign it with the owner wallet.");
            await continueFlow(next);
        }catch(error){setMessage(error instanceof Error?error.message:"The policy approval request could not be created");}
        finally{setBusy(false);}
    }
    function toggleCapability(bit:bigint,checked:boolean){setSelectedCapabilities(value=>{const current=BigInt(value);return (checked?current|bit:current&~bit).toString();});}
    const status=receipt?.status;
    return <section className="myso-agent-policy-controls" aria-label="Owner policy controls">
        <h3>Change agent policy</h3>
        <p className="myso-knowledge-note">Each change requires this account owner’s wallet signature. The contract checks the current agent identity and policy again before applying it.</p>
        {ownerMatches?<p className="myso-policy-wallet"><Wallet size={14}/> Owner wallet connected · {account!.address}</p>:<div className="myso-toolbar">{account&&<p className="myso-knowledge-note">Connected wallet {account.address} does not match this account owner.</p>}{wallets.map(wallet=><button key={wallet.name} type="button" className="myso-secondary" disabled={connect.isPending||busy} onClick={()=>void connect.mutateAsync({wallet,accountAddress:ownerAddress}).catch(error=>setMessage(error instanceof Error?error.message:"Wallet connection failed"))}><Wallet size={15}/>{connect.isPending?"Connecting…":`Connect ${wallet.name}`}</button>)}</div>}
        {quote.writesEnabled?<>
            <fieldset className="myso-agent-capabilities"><legend>Execution capabilities</legend><p>Current mask {quote.agent.expectedCapabilities}. Select the exact capability set to grant or remove.</p><div className="myso-agent-capability-grid">{capabilityOptions.filter(([bit])=>(supported&(1n<<bit))!==0n).map(([bit,label])=><label key={bit.toString()}><input type="checkbox" checked={(selected&(1n<<bit))!==0n} disabled={busy||!!flow&&flow.phase!=="finalized"} onChange={event=>toggleCapability(1n<<bit,event.target.checked)}/><span>{label}</span></label>)}</div><div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={busy||!ownerMatches||grantMask===0n||!!flow&&flow.phase!=="finalized"} onClick={()=>void request("grant_capability",{capabilityMask:grantMask.toString()})}>Grant selected capabilities<ArrowRight size={15}/></button><button type="button" className="myso-secondary" disabled={busy||!ownerMatches||revokeMask===0n||!!flow&&flow.phase!=="finalized"} onClick={()=>void request("revoke_capability",{capabilityMask:revokeMask.toString()})}>Remove selected capabilities<ArrowRight size={15}/></button></div></fieldset>
            <fieldset className="myso-agent-capabilities"><legend>Per-action MYSO limit</legend><p>Current: {quote.agent.expectedLimitMist==="unlimited"?"Unlimited":`${quote.agent.expectedLimitMist} MIST`}. This is a per-action ceiling, not a cumulative budget.</p><label htmlFor="agent-new-limit">New ceiling, in MIST</label><input id="agent-new-limit" inputMode="numeric" pattern="[0-9]+" value={newLimitMist} onChange={event=>setNewLimitMist(event.target.value)} disabled={busy||!!flow&&flow.phase!=="finalized"} placeholder="Enter an exact whole-number MIST amount"/><div className="myso-toolbar">{quote.agent.expectedLimitMist!=="unlimited"&&<><label className="myso-unlimited-choice"><input type="checkbox" checked={unlimited} disabled={busy||!!flow&&flow.phase!=="finalized"} onChange={event=>setUnlimited(event.target.checked)}/> Set to unlimited</label><button type="button" className="myso-secondary" disabled={busy||!ownerMatches||(!unlimited&&!/^(0|[1-9][0-9]{0,19})$/.test(newLimitMist))||!!flow&&flow.phase!=="finalized"} onClick={()=>void request("raise_spending_limit",{newLimitMist:unlimited?"unlimited":newLimitMist})}>Request higher ceiling<ArrowRight size={15}/></button></>}<button type="button" className="myso-secondary" disabled={busy||!ownerMatches||!(/^(0|[1-9][0-9]{0,19})$/.test(newLimitMist))||quote.agent.expectedLimitMist!=="unlimited"&&BigInt(newLimitMist||"0")>=BigInt(quote.agent.expectedLimitMist)||!!flow&&flow.phase!=="finalized"} onClick={()=>void request("lower_spending_limit",{newLimitMist})}>Request lower ceiling<ArrowRight size={15}/></button></div></fieldset>
            <div className="myso-agent-revoke"><div><strong>Revoke agent</strong><p>Irreversible. Revocation removes the agent on chain and prevents future execution through that identity.</p></div><button type="button" className="myso-secondary" disabled={busy||!ownerMatches||!!flow&&flow.phase!=="finalized"} onClick={()=>void request("revoke",{confirmed:true})}>Request revocation<ArrowRight size={15}/></button></div>
        </>:<p className="myso-knowledge-note">Owner policy changes are disabled for this deployment.</p>}
        {flow&&<div className="myso-agent-policy-pending" aria-live="polite"><div><p className="myso-eyebrow">OWNER APPROVAL · {flow.phase.toUpperCase()}</p><strong>{actionLabel}</strong><small>Approval {flow.approvalId} · idempotency {flow.idempotencyKey}</small>{flow.digest&&<small>Transaction {flow.digest}</small>}</div><details><summary>Review signed intent</summary><pre>{flow.approvalIntent}</pre></details><div className="myso-toolbar">{flow.phase!=="finalized"&&flow.phase!=="submitted"&&<button type="button" className="myso-primary" disabled={busy||!ownerMatches} onClick={()=>void continueFlow(flow)}>{busy?"Waiting for wallet…":flow.phase==="requested"?"Sign and continue":flow.phase==="approved"||flow.phase==="prepared"?"Review transaction and continue":"Continue"}<Check size={15}/></button>}{flow.phase==="submitted"&&<button type="button" className="myso-secondary" disabled={busy} onClick={()=>void continueFlow(flow)}>Check policy receipt</button>}{flow.phase==="submitted"&&status==="failed"&&<button type="button" className="myso-secondary" onClick={()=>{setFlow(null);setReceipt(null);setMessage("Failed transaction dismissed. Refresh the policy before starting another change.");}}>Dismiss failed transaction</button>}{flow.phase==="finalized"&&<><button type="button" className="myso-secondary" onClick={onComplete}>Refresh live authority</button><button type="button" className="myso-secondary" onClick={()=>{setFlow(null);setReceipt(null);setMessage("");}}>Dismiss verified change</button></>}{(flow.phase==="requested"||flow.phase==="approved"||flow.phase==="prepared")&&<button type="button" className="myso-secondary" disabled={busy} onClick={()=>{setFlow(null);setReceipt(null);setMessage("Pending approval dismissed. No policy transaction was submitted.");}}>Discard pending request</button>}</div>{status&&<p className="myso-knowledge-note">Receipt status: {status}{receipt?.evidence.length?" · native event verified":""}</p>}{message&&<p className="myso-knowledge-note" role="status">{message}</p>}{receipt&&status==="finalized"&&<div className="myso-verified-receipt"><strong>Finalized policy receipt verified</strong><span>{receipt.registryAction}</span><span>Evidence source: {receipt.evidenceSource}</span></div>}</div>}
        {!flow&&message&&<p className="myso-knowledge-note" role="status">{message}</p>}
    </section>;
}
