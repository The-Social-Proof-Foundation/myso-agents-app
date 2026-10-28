"use client";

import { useEffect, useState } from "react";
import { useConnectWallet, useCurrentAccount, useCurrentWallet, useSignPersonalMessage, useSignTransaction, useWallets } from "@socialproof/dapp-kit";
import { ArrowRight, RefreshCw, Wallet } from "lucide-react";

type Action="define_role"|"assign_role"|"revoke_role"|"create_invitation";
type Params=Record<string,string>;
type Phase="requested"|"approved"|"prepared"|"submitted"|"finalized";
type Flow={action:Action;organizationId:string;parameters:Params;idempotencyKey:string;approvalId:string;approvalIntent:string;registryAction:string;phase:Phase;digest?:string};
type ResponseData={approvalId?:string;approvalIntent?:string;registryAction?:string;parameters?:Params;idempotencyKey?:string;bytes?:string;digest?:string;status?:string;events?:unknown[];error?:string};
type OrgLists={organizationId:string;roles:unknown;assignments:unknown;invitations:unknown;evidence:"bounded_indexer_preview"};
const same=(a:string,b:string)=>a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
async function accessApi<T>(body:Record<string,unknown>):Promise<T>{
    const response=await fetch("/api/myso/organization-access",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const value=await response.json() as ResponseData;
    if(!response.ok)throw new Error(value.error??"Organization role management could not continue");
    return value as T;
}
function rows(value:unknown):Record<string,unknown>[]{
    if(Array.isArray(value))return value.filter((item):item is Record<string,unknown>=>!!item&&typeof item==="object"&&!Array.isArray(item));
    if(value&&typeof value==="object")for(const key of ["items","data","roles","assignments","invitations","results"]){const nested=(value as Record<string,unknown>)[key];if(Array.isArray(nested))return rows(nested);}
    return [];
}
function field(row:Record<string,unknown>,...keys:string[]){for(const key of keys){const value=row[key];if(typeof value==="string"||typeof value==="number")return String(value);}return "—";}
function validFlow(value:unknown):value is Flow{
    if(!value||typeof value!=="object")return false;const flow=value as Partial<Flow>;
    return ["define_role","assign_role","revoke_role","create_invitation"].includes(flow.action??"")&&/^0x[0-9a-fA-F]{1,64}$/.test(flow.organizationId??"")&&!!flow.parameters&&typeof flow.parameters==="object"&&typeof flow.idempotencyKey==="string"&&typeof flow.approvalId==="string"&&typeof flow.approvalIntent==="string"&&typeof flow.registryAction==="string"&&["requested","approved","prepared","submitted","finalized"].includes(flow.phase??"");
}
const eventNames:Record<Action,string>={define_role:"OrgRoleDefined",assign_role:"OrgRoleAssigned",revoke_role:"OrgRoleRevoked",create_invitation:"OrgInvitationCreated"};
const titles:Record<Action,string>={define_role:"Define role",assign_role:"Assign role",revoke_role:"Revoke role",create_invitation:"Create invitation"};

export function MySoOrganizationAccess({organizationId,ownerAddress,network}:{organizationId?:string;ownerAddress:string;network:string}){
    const wallets=useWallets();const account=useCurrentAccount();const {currentWallet}=useCurrentWallet();const connect=useConnectWallet();const signMessage=useSignPersonalMessage();const signTransaction=useSignTransaction();
    const [action,setAction]=useState<Action>("define_role");const [organization,setOrganization]=useState(organizationId??"");const [roleName,setRoleName]=useState("");const [mask,setMask]=useState("");const [member,setMember]=useState("");const [invitee,setInvitee]=useState("");const [expiresAtMs,setExpiresAtMs]=useState("");const [lists,setLists]=useState<OrgLists|null>(null);const [flow,setFlow]=useState<Flow|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");const [hydrated,setHydrated]=useState(false);
    const signerMatches=!!account&&same(account.address,ownerAddress)&&!!currentWallet;const chain=`myso:${network}` as `${string}:${string}`;const storageKey=`myso-agents:org-access:${network}:${ownerAddress.toLowerCase()}:${organization.toLowerCase()}`;
    useEffect(()=>setOrganization(organizationId??""),[organizationId]);
    useEffect(()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw){const parsed=JSON.parse(raw) as unknown;if(validFlow(parsed))setFlow(parsed);}}catch{}finally{setHydrated(true);}},[storageKey]);
    useEffect(()=>{if(!hydrated)return;if(flow)sessionStorage.setItem(storageKey,JSON.stringify(flow));else sessionStorage.removeItem(storageKey);},[flow,hydrated,storageKey]);
    useEffect(()=>{if(!organizationId||!/^0x[0-9a-fA-F]{1,64}$/.test(organizationId))return;let active=true;void accessApi<OrgLists>({operation:"read",organizationId}).then(value=>{if(active&&same(value.organizationId,organizationId)&&value.evidence==="bounded_indexer_preview")setLists(value);}).catch(error=>{if(active)setMessage(error instanceof Error?error.message:"Organization lists could not be loaded");});return()=>{active=false;}},[organizationId]);
    async function refresh(){if(!/^0x[0-9a-fA-F]{1,64}$/.test(organization))return;const value=await accessApi<OrgLists>({operation:"read",organizationId:organization});if(!same(value.organizationId,organization)||value.evidence!=="bounded_indexer_preview")throw new Error("Organization list response did not match the selected organization");setLists(value);}
    async function readReceipt(target:Flow){
        if(!target.digest)throw new Error("The organization transaction digest is missing");
        const result=await accessApi<ResponseData>({operation:"receipt",action:target.action,digest:target.digest});
        if(result.digest!==target.digest||result.registryAction!==target.registryAction)throw new Error("The receipt does not match the requested organization action");
        if(result.status==="finalized"){
            if(!Array.isArray(result.events)||result.events.length!==1)throw new Error("Finalized receipt must contain exactly one matching organization event");
            const event=result.events[0] as {type?:unknown;parsedJson?:Record<string,unknown>};
            if(typeof event?.type!=="string"||!event.type.endsWith(`::${eventNames[target.action]}`)||!event.parsedJson||!same(String(event.parsedJson.organization_id??""),target.organizationId))throw new Error("Finalized organization event did not match the selected action and organization");
            if(target.action==="define_role"&&(event.parsedJson.role_name!==target.parameters.roleName||String(event.parsedJson.mask)!==target.parameters.permissionsMask))throw new Error("The finalized role event does not match the selected role and mask");
            if((target.action==="assign_role"||target.action==="revoke_role")&&(event.parsedJson.role_name!==target.parameters.roleName||!same(String(event.parsedJson.member??""),target.parameters.memberAddress??"")))throw new Error("The finalized role-assignment event does not match the selected member and role");
            if(target.action==="create_invitation"&&!same(String(event.parsedJson.invitee??""),target.parameters.invitee??""))throw new Error("The finalized invitation event does not match the selected invitee");
            setFlow({...target,phase:"finalized"});setMessage(`${titles[target.action]} finalized; the matching organization event was verified.`);await refresh();
        }else if(result.status==="failed")setMessage("The transaction failed on chain; no organization change finalized.");
        else setMessage("The fullnode has not checkpointed this exact organization event yet. Check again before relying on it.");
    }
    async function continueFlow(target:Flow){
        if(!signerMatches){setMessage("Connect the MySo account owner wallet recorded for this organization action.");return;}
        setBusy(true);setMessage("");let current=target;
        try{
            if(current.phase==="requested"){
                setMessage("Sign the exact organization action approval in your wallet…");const signed=await signMessage.mutateAsync({message:new TextEncoder().encode(current.approvalIntent),chain});
                await accessApi({operation:"approve",approvalId:current.approvalId,walletSignature:signed.signature});current={...current,phase:"approved"};setFlow(current);
            }
            if(current.phase==="approved"||current.phase==="prepared"){
                setMessage("Preparing the approved action against current chain state…");const prepared=await accessApi<ResponseData>({operation:"prepare",action:current.action,parameters:current.parameters,idempotencyKey:current.idempotencyKey,approvalId:current.approvalId});
                if(prepared.registryAction!==current.registryAction||prepared.approvalId!==current.approvalId||prepared.idempotencyKey!==current.idempotencyKey||!prepared.bytes||!prepared.digest||current.digest&&current.digest!==prepared.digest)throw new Error("Prepared transaction did not match the approved organization action");
                current={...current,phase:"prepared",digest:prepared.digest};setFlow(current);setMessage("Review and sign the exact organization transaction in your wallet…");
                const signed=await signTransaction.mutateAsync({transaction:prepared.bytes,chain});await accessApi({operation:"submit",action:current.action,idempotencyKey:current.idempotencyKey,approvalId:current.approvalId,digest:prepared.digest,walletSignature:signed.signature});current={...current,phase:"submitted",digest:prepared.digest};setFlow(current);await readReceipt(current);
            }else if(current.phase==="submitted")await readReceipt(current);else setMessage("This organization action is finalized and verified.");
        }catch(error){setMessage(error instanceof Error?error.message:"Organization action could not finish");if(current.digest)try{await readReceipt(current);}catch{/* Keep the exact digest for safe reconciliation. */}}
        finally{setBusy(false);}
    }
    function parameters():Params{
        if(!/^0x[0-9a-fA-F]{1,64}$/.test(organization))throw new Error("Enter the organization object ID");
        if(action==="define_role")return {organizationId:organization,roleName:roleName.trim(),permissionsMask:mask};
        if(action==="assign_role"||action==="revoke_role")return {organizationId:organization,memberAddress:member.trim(),roleName:roleName.trim()};
        return {organizationId:organization,invitee:invitee.trim(),...(roleName.trim()?{roleName:roleName.trim()}:{}),permissionsMask:mask,...(expiresAtMs?{expiresAtMs}:{})};
    }
    async function request(){
        if(!signerMatches){setMessage("Connect the account owner wallet before creating an organization action.");return;}setBusy(true);setMessage("");
        try{
            const values=parameters();if((action==="define_role"||action==="assign_role"||action==="revoke_role")&&!values.roleName)throw new Error("Enter the role name");if(action==="create_invitation"&&!values.roleName&&values.permissionsMask==="0")throw new Error("Choose a role or nonzero permissions mask");
            if(["assign_role","revoke_role"].includes(action)&&!/^0x[0-9a-fA-F]{1,64}$/.test(values.memberAddress??""))throw new Error("Enter the exact member wallet address");
            if(action==="create_invitation"&&!/^0x[0-9a-fA-F]{1,64}$/.test(values.invitee??""))throw new Error("Enter the exact invitee wallet address");
            if(action==="revoke_role"&&!window.confirm(`Revoke ${values.roleName} from ${values.memberAddress}? The contract removes only the permissions granted by that role assignment.`))return;
            const idempotencyKey=`org-access:${crypto.randomUUID()}`;const response=await accessApi<ResponseData>({operation:"request",action,parameters:values,idempotencyKey});
            if(response.registryAction!==`organization.${action}.v1`||!response.approvalId||!response.approvalIntent||response.idempotencyKey!==idempotencyKey)throw new Error("The approval does not match the selected organization action");
            const next:Flow={action,organizationId:organization,parameters:values,idempotencyKey,approvalId:response.approvalId,approvalIntent:response.approvalIntent,registryAction:response.registryAction,phase:"requested"};setFlow(next);await continueFlow(next);
        }catch(error){setMessage(error instanceof Error?error.message:"Organization action approval could not be requested");}finally{setBusy(false);}
    }
    const locked=busy||!!flow&&flow.phase!=="finalized";
    const list=(label:string,value:unknown,keys:readonly string[])=>{const items=rows(value);return <section className="myso-create" key={label}><h4>{label}</h4>{items.length?items.map((item,index)=><p className="myso-knowledge-note" key={`${label}-${index}`}>{keys.map(key=>`${key}: ${field(item,key)}`).join(" · ")}</p>):<p className="myso-knowledge-note">No indexed entries on this page.</p>}</section>;};
    return <section className="myso-create myso-organization-access" aria-labelledby="org-access-title">
        <h3 id="org-access-title">Organization roles and invitations</h3>
        <p>Review bounded indexer previews and manage custom roles, assignments and invitations. Every write uses an owner-wallet approval; Move rechecks live organization and group authority. Invitations become effective only when the addressed wallet accepts them.</p>
        <label htmlFor="org-access-id">Organization object ID</label><input id="org-access-id" value={organization} onChange={event=>setOrganization(event.target.value.trim())} placeholder="0x…" disabled={locked}/>
        <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={busy||!organization} onClick={()=>void refresh().catch(error=>setMessage(error instanceof Error?error.message:"Organization lists could not be refreshed"))}><RefreshCw size={15}/> Refresh roles and invitations</button><span>Connected signer: {signerMatches?account!.address:"owner wallet required"}</span></div>
        {!signerMatches&&<div className="myso-toolbar">{wallets.map(wallet=><button key={wallet.name} type="button" className="myso-secondary" disabled={connect.isPending||busy} onClick={()=>connect.mutate({wallet,accountAddress:ownerAddress})}><Wallet size={15}/>{connect.isPending?"Connecting…":`Connect ${wallet.name}`}</button>)}</div>}
        <div className="myso-toolbar" role="group" aria-label="Organization management action">{(Object.keys(titles) as Action[]).map(value=><button key={value} type="button" className={action===value?"myso-primary":"myso-secondary"} disabled={locked} onClick={()=>setAction(value)}>{titles[value]}</button>)}</div>
        <label htmlFor="org-role-name">Role name</label><input id="org-role-name" value={roleName} onChange={event=>setRoleName(event.target.value)} maxLength={256} placeholder="e.g. Knowledge curator" disabled={locked}/>
        {action==="define_role"&&<><label htmlFor="org-role-mask">Permission mask</label><input id="org-role-mask" inputMode="numeric" value={mask} onChange={event=>setMask(event.target.value)} placeholder="Unsigned decimal bitmask" disabled={locked}/><p className="myso-knowledge-note">Use the permission bits supported by the deployed MySo package. The server and Move contract validate the mask.</p></>}
        {(action==="assign_role"||action==="revoke_role")&&<><label htmlFor="org-role-member">Member wallet</label><input id="org-role-member" value={member} onChange={event=>setMember(event.target.value.trim())} placeholder="0x…" disabled={locked}/></>}
        {action==="create_invitation"&&<><label htmlFor="org-invitee">Invitee wallet</label><input id="org-invitee" value={invitee} onChange={event=>setInvitee(event.target.value.trim())} placeholder="0x…" disabled={locked}/><label htmlFor="org-invite-mask">Additional permission mask</label><input id="org-invite-mask" inputMode="numeric" value={mask} onChange={event=>setMask(event.target.value)} placeholder="0 if role alone is sufficient" disabled={locked}/><label htmlFor="org-invite-expiry">Invitation expiry in Unix milliseconds (optional)</label><input id="org-invite-expiry" inputMode="numeric" value={expiresAtMs} onChange={event=>setExpiresAtMs(event.target.value)} placeholder="Leave blank for no expiry" disabled={locked}/></>}
        <div className="myso-toolbar">{!flow&&<button type="button" className="myso-primary" disabled={busy||!signerMatches||!organization||((action==="define_role"||action==="assign_role"||action==="revoke_role")&&!roleName.trim())||(action==="create_invitation"&&!roleName.trim()&&(!mask||mask==="0"))} onClick={()=>void request()}>{busy?"Working…":"Review and sign"}<ArrowRight size={15}/></button>}{flow&&flow.phase!=="finalized"&&<button type="button" className="myso-primary" disabled={busy||!signerMatches} onClick={()=>void continueFlow(flow)}>{busy?"Working…":flow.phase==="submitted"?"Check transaction receipt":"Continue approval"}</button>}{flow&&flow.phase==="finalized"&&<button type="button" className="myso-secondary" disabled={busy} onClick={()=>{setFlow(null);setMessage("");}}>Start another action</button>}</div>
        {flow&&<p className="myso-knowledge-note">Pending {titles[flow.action]} · {flow.phase}{flow.digest?<> · digest <code>{flow.digest}</code></>:null}</p>}{message&&<p role="status" className="myso-knowledge-note">{message}</p>}
        {lists&&<><p className="myso-knowledge-note">Lists below are bounded indexer previews, not live permission proof. Writes recheck authority on chain.</p>{list("Roles",lists.roles,["role_name","name","mask","permissions_mask"])}{list("Assignments",lists.assignments,["member","member_address","role_name","granted_mask"])}{list("Invitations",lists.invitations,["invitee","role_name","permissions_mask","expires_at_ms"])}</>}
    </section>;
}
