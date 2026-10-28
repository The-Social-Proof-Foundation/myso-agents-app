"use client";

import { useEffect, useState } from "react";
import { useConnectWallet, useCurrentAccount, useCurrentWallet, useSignPersonalMessage, useSignTransaction, useWallets } from "@socialproof/dapp-kit";
import { Check, RefreshCw, Wallet } from "lucide-react";
import { buildMySoMultisig, signMySoMessageWithMultisig, signMySoTransactionWithMultisig, type MySoMultisigMember } from "@/src/agent/myso-multisig";

type Approval={approvalId:string;registryAction:string;registryVersion:string;idempotencyKey:string;parameterHash:string;parameters:Record<string,unknown>;requiredCapability:number;riskTier:string;ownerAddress:string;approvalIntent:string;status:"pending";expiresAtMs:number};
type Flow=Omit<Approval,"status">&{phase:"approved"|"submitted";digest?:string};
type Reply={items?:Approval[];bytes?:string;digest?:string;status?:string;registryAction?:string;error?:string};
const same=(a:string,b:string)=>a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
async function approvalApi(body:Record<string,unknown>):Promise<Reply>{const response=await fetch("/api/myso/action-approvals",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const value=await response.json() as Reply;if(!response.ok)throw new Error(value.error??"Owner approval could not continue");return value;}
function validFlow(value:unknown):value is Flow{if(!value||typeof value!=="object")return false;const flow=value as Partial<Flow>;return typeof flow.approvalId==="string"&&typeof flow.registryAction==="string"&&typeof flow.idempotencyKey==="string"&&!!flow.parameters&&typeof flow.parameters==="object"&&typeof flow.approvalIntent==="string"&&["approved","submitted"].includes(flow.phase??"");}

export function MySoActionApprovals({ownerAddress,accountId,network}:{ownerAddress:string;accountId:string;network:string}){
    const wallets=useWallets();const account=useCurrentAccount();const {currentWallet}=useCurrentWallet();const connect=useConnectWallet();const signMessage=useSignPersonalMessage();const signTransaction=useSignTransaction();
    const [items,setItems]=useState<Approval[]>([]);const [flow,setFlow]=useState<Flow|null>(null);const [busy,setBusy]=useState(false);const [message,setMessage]=useState("");const [loaded,setLoaded]=useState(false);
    const [multisigAddresses,setMultisigAddresses]=useState<string[]>([]);const [multisigThreshold,setMultisigThreshold]=useState(0);
    const chain=`myso:${network}` as `${string}:${string}`;const ownerWalletMatches=!!account&&same(account.address,ownerAddress)&&!!currentWallet;const storageKey=`myso-agents:action-approvals:${network}:${ownerAddress.toLowerCase()}`;
    const multisigStorageKey=`myso-agents:owner-multisig:${network}:${accountId.replace(/^0x/i,"").toLowerCase().padStart(64,"0")}`;
    const availableMultisigAccounts=wallets.flatMap(wallet=>wallet.accounts.map(walletAccount=>({wallet,account:walletAccount,address:walletAccount.address,publicKey:Uint8Array.from(walletAccount.publicKey),weight:1})));
    const multisigMembers:Array<MySoMultisigMember&{wallet:typeof wallets[number];account:typeof wallets[number]["accounts"][number]}>=multisigAddresses.flatMap(address=>{const selected=availableMultisigAccounts.find(candidate=>same(candidate.address,address));return selected?[{...selected,address:selected.address}]:[];});
    let multisigConfig:ReturnType<typeof buildMySoMultisig>|null=null;
    if(multisigAddresses.length>=2&&multisigMembers.length===multisigAddresses.length){try{multisigConfig=buildMySoMultisig(multisigMembers,multisigThreshold);}catch{multisigConfig=null;}}
    const multisigWalletMatches=!!multisigConfig&&same(multisigConfig.address,ownerAddress);const matches=ownerWalletMatches||multisigWalletMatches;
    function reloadMultisigConfiguration(){setMultisigAddresses([]);setMultisigThreshold(0);try{const raw=localStorage.getItem(multisigStorageKey);if(!raw)return;const value=JSON.parse(raw) as {addresses?:unknown;threshold?:unknown};if(Array.isArray(value.addresses)&&value.addresses.length>=2&&value.addresses.length<=10&&value.addresses.every(address=>typeof address==="string"&&/^0x[0-9a-fA-F]{1,64}$/.test(address))&&new Set(value.addresses.map(address=>String(address).replace(/^0x/i,"").toLowerCase().padStart(64,"0"))).size===value.addresses.length&&typeof value.threshold==="string"&&/^\d{1,4}$/.test(value.threshold)&&Number(value.threshold)>=1){setMultisigAddresses(value.addresses);setMultisigThreshold(Number(value.threshold));}}catch{}}
    useEffect(()=>{reloadMultisigConfiguration();const onStorage=(event:StorageEvent)=>{if(event.key===multisigStorageKey)reloadMultisigConfiguration();};window.addEventListener("storage",onStorage);return()=>window.removeEventListener("storage",onStorage);},[multisigStorageKey]);
    useEffect(()=>{try{const raw=sessionStorage.getItem(storageKey);if(raw){const value=JSON.parse(raw) as unknown;if(validFlow(value))setFlow(value);}}catch{}finally{setLoaded(true);}},[storageKey]);
    useEffect(()=>{if(!loaded)return;if(flow)sessionStorage.setItem(storageKey,JSON.stringify(flow));else sessionStorage.removeItem(storageKey);},[flow,loaded,storageKey]);
    async function refresh(){setBusy(true);setMessage("");try{const result=await approvalApi({operation:"list"});setItems(result.items??[]);}catch(error){setMessage(error instanceof Error?error.message:"Pending approvals could not be loaded");}finally{setBusy(false);}}
    useEffect(()=>{void refresh();},[ownerAddress,network]);
    async function signApprovalIntent(text:string){const bytes=new TextEncoder().encode(text);if(ownerWalletMatches)return(await signMessage.mutateAsync({message:bytes,chain})).signature;if(!multisigWalletMatches||!multisigConfig)throw new Error("Connect the configured owner multisig signer wallets before approving");return signMySoMessageWithMultisig({multisig:multisigConfig,message:bytes,chain,signers:multisigMembers.map(member=>({wallet:member.wallet as never,account:member.account as never}))});}
    async function signPreparedTransaction(bytes:string){if(multisigConfig){try{const signed=await signMySoTransactionWithMultisig({multisig:multisigConfig,transactionBlockBase64:bytes,chain,signers:multisigMembers.map(member=>({wallet:member.wallet as never,account:member.account as never}))});return signed.signature;}catch(error){const message=error instanceof Error?error.message:"";if(!message.includes("must be the configured multisig"))throw error;}}if(ownerWalletMatches)return(await signTransaction.mutateAsync({transaction:bytes,chain})).signature;throw new Error("Connect the wallet that matches this transaction sender before signing");}
    async function continueFlow(target:Flow){
        if(!matches){setMessage("Connect the account owner wallet or all configured owner multisig signer wallets before signing this action.");return;}setBusy(true);setMessage("");const chainAction=target.registryAction;
        try{
            if(target.phase==="approved"){
                setMessage("Preparing the exact approved action against current chain state…");const prepared=await approvalApi({operation:"prepare",approvalId:target.approvalId,registryAction:chainAction,idempotencyKey:target.idempotencyKey,parameters:target.parameters});
                if(!prepared.bytes||!prepared.digest||prepared.registryAction!==chainAction||target.digest&&target.digest!==prepared.digest)throw new Error("Prepared transaction did not match the selected approval");
                target={...target,digest:prepared.digest};setFlow(target);setMessage(`Review the ${chainAction} transaction in your wallet. Digest: ${prepared.digest}`);
                const walletSignature=await signPreparedTransaction(prepared.bytes);
                await approvalApi({operation:"submit",approvalId:target.approvalId,registryAction:chainAction,idempotencyKey:target.idempotencyKey,digest:prepared.digest,walletSignature});
                target={...target,phase:"submitted",digest:prepared.digest};setFlow(target);
            }
            if(!target.digest)throw new Error("The submitted transaction digest is missing");
            const receipt=await approvalApi({operation:"receipt",digest:target.digest});
            if(receipt.digest!==target.digest||receipt.registryAction!==chainAction)throw new Error("Receipt did not match the approved action and transaction");
            if(receipt.status==="finalized"||receipt.status==="executed"){setMessage(`${chainAction} finalized and verified on chain.`);setFlow(null);await refresh();}
            else if(receipt.status==="failed")setMessage("The transaction failed on chain; the action was not finalized.");
            else setMessage("The exact transaction is submitted. Its finalized receipt is not available yet; check again shortly.");
        }catch(error){setMessage(error instanceof Error?error.message:"The owner-approved action could not finish");}
        finally{setBusy(false);}
    }
    async function approve(item:Approval){
        if(!matches){setMessage("Connect the account owner wallet or all configured owner multisig signer wallets.");return;}if(Date.now()>=item.expiresAtMs){setMessage("This approval request expired. Refresh the list before continuing.");return;}
        setBusy(true);setMessage("Review the exact action and sign its approval intent in your wallet…");
        try{const walletSignature=await signApprovalIntent(item.approvalIntent);await approvalApi({operation:"approve",approvalId:item.approvalId,walletSignature});const next:Flow={...item,phase:"approved"};setFlow(next);setItems(values=>values.filter(row=>row.approvalId!==item.approvalId));await continueFlow(next);}
        catch(error){setMessage(error instanceof Error?error.message:"Owner approval could not be recorded");setBusy(false);}
    }
    return <section className="myso-create" aria-label="Pending hosted action approvals"><div className="myso-page-heading"><div><p className="myso-eyebrow">OWNER APPROVALS</p><h2>Review agent actions</h2></div><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={15}/>Refresh</button></div>
        <p className="myso-knowledge-note">Requests are scoped to this account and agent. Review the exact parameters before signing. Approval records permission only; each transaction is prepared against current chain state and requires a separate wallet signature.</p>
        {!ownerWalletMatches&&<p className="myso-knowledge-note">For a protocol multisig owner, configure its member wallets in Owner key migration, then connect those same accounts here. <button type="button" className="myso-secondary" disabled={busy} onClick={reloadMultisigConfiguration}>Refresh multisig signer set</button>{multisigAddresses.length>0&&!multisigWalletMatches&&<span> The current connected accounts do not yet reproduce the configured owner address.</span>}</p>}
        {multisigWalletMatches&&<p className="myso-knowledge-note">Signing as the configured MySo protocol multisig ({multisigThreshold}-of-{multisigAddresses.length}). Each connected member wallet will be asked to sign the same approval and transaction; signing keys remain in those wallets.</p>}
        {!matches&&<div className="myso-toolbar">{wallets.map(wallet=><button key={wallet.name} type="button" className="myso-secondary" disabled={connect.isPending||busy} onClick={()=>connect.mutate({wallet})}><Wallet size={15}/>{connect.isPending?"Connecting…":`Connect ${wallet.name}`}</button>)}</div>}
        {items.length?items.map(item=><article className="myso-knowledge-note" key={item.approvalId}><p className="myso-eyebrow">{item.riskTier} · expires {new Date(item.expiresAtMs).toLocaleString()}</p><h3>{item.registryAction}</h3><p>Capability {item.requiredCapability} · {item.registryVersion}</p><details><summary>Review exact parameters</summary><pre>{JSON.stringify(item.parameters,null,2)}</pre><p>Parameter hash: <code>{item.parameterHash}</code></p><p>Wallet intent: <code>{item.approvalIntent}</code></p></details><button type="button" className="myso-primary" disabled={busy||!matches} onClick={()=>void approve(item)}>{busy?"Waiting for wallet…":"Approve, review transaction, and sign"}<Check size={15}/></button></article>):!busy&&<p className="myso-knowledge-note">No unexpired pending requests for this agent.</p>}
        {flow&&<article className="myso-knowledge-note"><p className="myso-eyebrow">{flow.phase.toUpperCase()}</p><h3>{flow.registryAction}</h3><pre>{JSON.stringify(flow.parameters,null,2)}</pre>{flow.digest&&<p>Transaction <code>{flow.digest}</code></p>}{flow.phase==="approved"&&<button type="button" className="myso-primary" disabled={busy||!matches} onClick={()=>void continueFlow(flow)}>Prepare and sign transaction</button>}{flow.phase==="submitted"&&<button type="button" className="myso-secondary" disabled={busy} onClick={()=>void continueFlow(flow)}>Check finalized receipt</button>}</article>}
        {message&&<p className="myso-knowledge-note" role="status">{message}</p>}
    </section>;
}
