"use client";

import { useEffect, useState } from "react";
import { Check, RefreshCw, X } from "lucide-react";

type Decision="accept"|"decline";
type Invitation={organization_id:string;invitee_address:string;role_name:string|null;permissions_mask:string|number;invited_by:string;created_at_ms:string|number;expires_at_ms:string|number|null;status:string};
type Pending={organizationId:string;decision:Decision;digest:string};
type Result={invitations?:unknown;evidence?:string;organizationId?:string;decision?:Decision;digest?:string;registryAction?:string;status?:"finalized"|"executed"|"failed"|"unknown";events?:unknown[];error?:string};
const same=(a:string,b:string)=>a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
const eventName:Record<Decision,string>={accept:"OrgInvitationAccepted",decline:"OrgInvitationDeclined"};
async function api<T extends Result>(body:Record<string,unknown>):Promise<T>{
    const response=await fetch("/api/myso/organization-invitations",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const value=await response.json() as T;if(!response.ok)throw new Error(value.error??"Invitation action could not continue");return value;
}
function invitationRows(value:unknown):Invitation[]{
    if(!Array.isArray(value))return[];
    return value.filter((item):item is Invitation=>!!item&&typeof item==="object"&&!Array.isArray(item)&&typeof (item as Invitation).organization_id==="string"&&typeof (item as Invitation).invitee_address==="string"&&(item as Invitation).status==="pending");
}
function validPending(value:unknown):value is Pending{return !!value&&typeof value==="object"&&/^0x[0-9a-fA-F]{1,64}$/.test((value as Pending).organizationId??"")&&["accept","decline"].includes((value as Pending).decision??"")&&/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test((value as Pending).digest??"");}
function eventMatches(result:Result,pending:Pending,agentAddress:string){
    if(result.status!=="finalized"||result.organizationId!==pending.organizationId||result.decision!==pending.decision||result.registryAction!==`organization.${pending.decision}_invitation.v1`||!Array.isArray(result.events)||result.events.length!==1)return false;
    const event=result.events[0] as {type?:unknown;parsedJson?:Record<string,unknown>};
    return typeof event?.type==="string"&&event.type.endsWith(`::${eventName[pending.decision]}`)&&!!event.parsedJson&&same(String(event.parsedJson.organization_id??""),pending.organizationId)&&same(String(event.parsedJson.invitee??""),agentAddress);
}
function date(value:string|number|null){if(value===null)return "No expiry";const time=Number(value);return Number.isFinite(time)?new Date(time).toLocaleString():"Unknown expiry";}

export function MySoOrganizationInvitations({agentAddress,network}:{agentAddress:string;network:string}){
    const [invitations,setInvitations]=useState<Invitation[]>([]);const [pending,setPending]=useState<Pending|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");const storageKey=`myso-agents:org-invitation:${network}:${agentAddress.toLowerCase()}`;
    useEffect(()=>{try{const saved=JSON.parse(sessionStorage.getItem(storageKey)??"null") as unknown;if(validPending(saved))setPending(saved);}catch{/* An invalid recovery record is ignored. */}},[storageKey]);
    useEffect(()=>{if(pending)sessionStorage.setItem(storageKey,JSON.stringify(pending));else sessionStorage.removeItem(storageKey);},[pending,storageKey]);
    async function refresh(){setBusy(true);setMessage("");try{const result=await api({operation:"list",limit:100,offset:0});if(result.evidence!=="bounded_pending_invitee_indexer_preview")throw new Error("Invitation list did not match the expected bounded preview");setInvitations(invitationRows(result.invitations));}catch(error){setMessage(error instanceof Error?error.message:"Invitations could not be refreshed");}finally{setBusy(false);}}
    useEffect(()=>{void refresh();},[agentAddress]);
    async function reconcile(target:Pending){setBusy(true);setMessage("Checking the exact invitation action receipt…");try{const result=await api({operation:"receipt",organizationId:target.organizationId,decision:target.decision,digest:target.digest});if(eventMatches(result,target,agentAddress)){setPending(null);setMessage(`Invitation ${target.decision} was finalized and verified.`);await refresh();}else if(result.status==="failed"){setPending(null);setMessage("The invitation transaction failed; no membership change finalized.");}else setMessage("The exact invitation event is not checkpointed yet. Check again before relying on this action.");}catch(error){setMessage(error instanceof Error?error.message:"Receipt could not be checked");}finally{setBusy(false);}}
    async function respond(invitation:Invitation,decision:Decision){if(pending)return;if(!same(invitation.invitee_address,agentAddress)){setMessage("This invitation is not addressed to the authenticated agent.");return;}if(decision==="decline"&&!window.confirm("Decline this organization invitation?"))return;setBusy(true);setMessage("");try{const result=await api({operation:"respond",organizationId:invitation.organization_id,decision,idempotencyKey:`org-invitation:${crypto.randomUUID()}`});if(result.status==="failed"){setMessage("The invitation transaction failed on chain; no membership change finalized.");return;}const target={organizationId:invitation.organization_id,decision,digest:result.digest??""};if(!validPending(target))throw new Error("The invitation response omitted its transaction digest");if(eventMatches(result,target,agentAddress)){setMessage(`Invitation ${decision} was finalized and verified.`);await refresh();}else{setPending(target);setMessage("Invitation action submitted; its exact event is awaiting checkpoint verification.");}}catch(error){setMessage(error instanceof Error?error.message:"Invitation response could not be submitted");}finally{setBusy(false);}}
    return <section className="myso-create myso-organization-invitations" aria-labelledby="org-invitations-title">
        <div className="myso-toolbar"><div><h3 id="org-invitations-title">Invitations for this agent</h3><p>Accept or decline pending invitations addressed to this agent wallet. Membership changes only after the exact MySo event is finalized.</p></div><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={15}/>Refresh</button></div>
        <p className="myso-knowledge-note">Agent wallet: <code>{agentAddress}</code> · results are bounded indexer previews and may lag chain state.</p>
        {pending&&<div className="myso-toolbar"><span>Pending receipt check · {pending.decision} · <code>{pending.digest}</code></span><button type="button" className="myso-primary" disabled={busy} onClick={()=>void reconcile(pending)}>Check receipt</button></div>}
        {invitations.length===0?<p className="myso-knowledge-note">No pending invitations appeared in the latest indexed page.</p>:invitations.map((invitation,index)=><article className="myso-create" key={`${invitation.organization_id}:${index}`}>
            <h4>{invitation.role_name?`Role: ${invitation.role_name}`:"Direct organization permissions"}</h4>
            <p className="myso-knowledge-note">Organization <code>{invitation.organization_id}</code> · permissions {String(invitation.permissions_mask)} · invited by <code>{invitation.invited_by}</code></p>
            <p className="myso-knowledge-note">Created {date(invitation.created_at_ms)} · expires {date(invitation.expires_at_ms)}</p>
            <div className="myso-toolbar"><button type="button" className="myso-primary" disabled={busy||!!pending} onClick={()=>void respond(invitation,"accept")}><Check size={15}/>Accept</button><button type="button" className="myso-secondary" disabled={busy||!!pending} onClick={()=>void respond(invitation,"decline")}><X size={15}/>Decline</button></div>
        </article>)}
        {message&&<p className="myso-knowledge-note" role="status">{message}</p>}
    </section>;
}
