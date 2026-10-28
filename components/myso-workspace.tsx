"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useTheme } from "next-themes";
import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { normalizeKeyAddress, type AgentKeyEnvelopeV1 } from "@socialproof/memory";
import { useConnectWallet, useCurrentAccount, useSignPersonalMessage, useWallets } from "@socialproof/dapp-kit";
import { ArrowLeft, ArrowRight, BookOpen, Bot, Briefcase, Building2, Check, ChevronRight, Circle, ClipboardList, Clock3, Layers3, ListTodo, MessageCircle, Menu, Moon, PanelLeft, Plus, ReceiptText, RefreshCw, Store, Sun, Wallet, X } from "lucide-react";
import { mySoTaskScopeSchema, type WorkRun, type ExecutionScope, type RoomHistoryPage, type RoomMemberPage, type RoomReceipts, type RoomReceiptUpdateResult } from "@/src/core";
import { namedSellerBuyerSteps, namedSellerSellerSteps } from "@/src/core/contracts/work";
import { HOSTED_WORK_PRIVATE_CONTENT_OUTPUT_TOOLS, HOSTED_WORK_PRIVATE_GRAPH_TOOLS, HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS, HOSTED_WORK_ROOM_CONTENT_TOOLS, isHostedWorkToolForbidden } from "@/src/core/hosted-work-tool-policy";

import { AccountMenu } from "./account-menu";
import { CalloutButton } from "./callout-button";
import { LOGIN_SUCCESS_HOLD_MS, LoginStatusOverlay } from "./login-status-overlay";
import { signInWithMySocial } from "./mysocial-sign-in";
import { setCustodyAccessToken } from "@/src/agent/custody-session";
import { deriveMySocialLoginSeed } from "@/src/agent/custody-session";
import { CustodyVault, PRIMARY_CUSTODY } from "@/src/agent/custody-vault";
import { MySoKnowledgeReader } from "./myso-knowledge-reader";
import { MySoBeneficiaryTransfer } from "./myso-beneficiary-transfer";
import { MySoOrganizationTreasury } from "./myso-organization-treasury";
import { MySoOrganizationAccess } from "./myso-organization-access";
import { MySoActionApprovals } from "./myso-action-approvals";
import { MySoOrganizationInvitations } from "./myso-organization-invitations";
import { MySoPlatformAdmin } from "./myso-platform-admin";
import { MySoAccountUsage } from "./myso-account-usage";
import { MySoAgentAuthority } from "./myso-agent-authority";
import { MySoSubscriptions } from "./myso-subscriptions";
import { MySoPostTip } from "./myso-post-tip";
import { MySoRoomBulkRemove } from "./myso-room-bulk-remove";
import { MySoDeliveryManifest, type DeliveryCheck } from "./myso-delivery-manifest";
import { MySoAutomationDelegateSetup } from "./myso-automation-delegate-setup";
import { MySoAutomationJobCreate, type AutomationJobCreateInput, type AutomationJobValidation } from "./myso-automation-job-create";
import { MySoAutomationJobEdit, type AutomationJobConfiguration } from "./myso-automation-job-edit";
import { MySoAutomationSimulator, type AutomationSimulationResult } from "./myso-automation-simulator";
import { MySoRoomNameEditor } from "./myso-room-name-editor";
import { MySoOwnerRotation } from "./myso-owner-rotation";
import { MySoRoomConversation } from "./myso-room-conversation";
import { MySoTaskOfferComposer } from "./myso-task-offer-composer";
import { MySoTaskDispute } from "./myso-task-dispute";
import { MySoTaskDisputeResponse } from "./myso-task-dispute-response";
import { MySoTaskDisputeAgreement } from "./myso-task-dispute-agreement";
import { MySoTaskDisputeAppeal } from "./myso-task-dispute-appeal";
import { MySoTaskDisputeEvidence } from "./myso-task-dispute-evidence";
import { MySoJuryDuties } from "./myso-jury-duties";
import { MySoTaskRefund } from "./myso-task-refund";
import { HERO_CHAT_CRITERION, MySoHome } from "./myso-home";
import { buildTaskDeliveryPackage, taskDeliverySelectionKey, verifyTaskDeliveryPackage } from "@/src/agent/task-delivery-package";

interface Context { scope:ExecutionScope; label:string; derivedAddress:string; rpcUrl:string; socialChain:{packageId:string;memoryConfigId:string;platformObjectId:string;usernameRegistryId?:string;memoryRegistryId?:string;clockId?:string;[key:string]:unknown} }
interface SignedInAccount { owner:string|null; label:string }
interface ContextResponse { signedIn?:boolean; scope:ExecutionScope|null; label:string; owner:string|null; derivedAddress?:string; rpcUrl?:string; socialChain?:Context["socialChain"] }
interface Summary {id:string;status:string;createdAt:string;revision:number;cancelRequestedAt?:string|null}
interface RunAiUsage {runId:string;steps:{stepId:string;title:string;spentMist:string;unresolved:number;operations:number}[];coordination:{spentMist:string;unresolved:number;operations:number};actionSteps:{stepId:string;title:string;spentMist:string;reservedMist:string;operations:number}[]}
interface RunOperationJournal {runId:string;complete:true;verification:"scoped_encrypted_work_operation_journal";operations:Array<{id:string;toolName:string;toolCallId:string;inputHash:string;idempotencyKey:string;status:"pending"|"reconciling";maxAmountMist?:string;stepId?:string;error?:string}>}
interface RunOperationReceipt {runId:string;operationId:string;chainAction:{registryAction:string;status:string;parameterHash:string;digest?:string}|null;receipt:{digest:string;status:"finalized"|"checkpoint_pending"|"failed"|"unknown";checkpoint:string|number|null;eventTypes:string[]}|null;recoveredUpload?:{taskId:string;uri:string;digestHex:string;contentLength:number;verification:string}|null;retry?:{taskId:string;idempotencyKey:string;digestHex:string};verification:string}
interface Tool {name:string;description:string;readOnly:boolean}
interface Model {id:string;display_name:string;context_length:number|null;max_output_tokens:number|null;supports_tools:boolean}
interface TaskMarketStats {openOffers:number;accepted:number;delivered:number;disputed:number;settled:number;refunded:number;cancelled:number;settledLast24h:number;activeAgents:number}
interface TaskMarketSeller {sellerAccountId:string;agentObjectId:string;capabilities:number;expiresAtMs:number|null;principal:string;label:string;organizationId:string|null;reviewCount:number;score:number;confidenceBps:number;settledCount:number;volumeMist:string;credibilityBps:number}
interface TaskAcceptResult {submitted:true;transactionDigest:string}
interface TaskAcceptReceipt {digest:string;taskId:string;status:"finalized"|"checkpoint_pending"|"failed"|"unknown";verification:"finalized_task_accepted_event"|"task_accept_receipt_not_finalized"}
interface TaskReviewResult {submitted:true;transactionDigest:string;taskId:string;raterRole:"buyer"|"seller";stars:number}
interface TaskReviewReceipt {digest:string;taskId:string;raterRole:"buyer"|"seller";stars:number;status:"finalized"|"checkpoint_pending"|"failed"|"unknown";verification:"finalized_task_review_submitted_event"|"task_review_receipt_not_finalized"}
interface TaskCancelOfferResult {submitted:true;transactionDigest:string;taskId:string}
interface TaskRoomBindResult {submitted:true;transactionDigest:string;taskId:string;roomGroupId:string}
interface RoomInviteResult {groupId:string;digest:string|null;member:string;historyAccess:"past_and_future";verification:string;source:"myso_fullnode"}
interface RoomRemovalResult {groupId:string;digest:string;member:string;keyVersionBefore:string;keyVersionAfter:string;futureAccess:"revoked";pastAccess:"may_remain_available_or_previously_copied";verification:"finalized_membership_and_key_version";source:"myso_fullnode"}
interface TaskDeliverResult {submitted:true;transactionDigest:string}
interface TaskUploadResult {taskId:string;uri:string;digestHex:string;contentLength:number;storage:"cloudflare_r2";idempotentReplay:boolean;disclosure:string}
interface TaskSettleResult {submitted:true;transactionDigest:string}
interface AutomationDelivery {id:string;job_id:string;event_key:string;status:string;attempts:number;lease_until?:string|null;error?:string|null;resolved_by?:string|null;resolution?:string|null;resolution_note?:string|null;resolution_history?:Array<{actor:string;resolution:string;note:string;createdAt?:string;created_at?:string}>}
interface AutomationRun {id:string;job_id:string;status:string;attempt:number;error:string|null;started_at:string;finished_at:string|null}
interface AutomationDelegate {delegate_ref:string;agent_object_id:string;mydata_key_id:string;delegate_class:"memory"|"task_worker"|"juror"|"action_worker";allowed_action_ids:string[];created_at:string;chainStatus:{status:"unavailable"}|{status:"active"|"inactive";delegate_class:"memory"|"task_worker"|"juror"|"action_worker";expires_at_ms:number|null;expires_in_ms:number|null;reason?:string}}
interface AutomationDelegateKeyEvent {id:string;delegate_ref:string;agent_object_id:string;mydata_key_id:string;event_type:"created"|"replaced"|"stored"|"deleted";recorded_at:string}
interface TaskDetail {taskId:string;title:string;status:number;roomGroupId:string|null;buyerPrincipal:string;buyerAgentId:string|null;buyerMemoryAccountId:string;scopeDigestHex:string;amountMist:string;sellerPrincipal:string;sellerAgentId:string;sellerMemoryAccountId:string;platformId:string|null;platformFeeBps:number;ecosystemFeeBps:number;createdAtMs:number;acceptDeadlineMs:number;acceptedAtMs:number|null;deliveryDeadlineMs:number|null;deliveredAtMs:number|null;settleDeadlineMs:number|null;settledAtMs:number|null;reviewDeadlineMs:number|null;refundProposer:number;refundProposedAtMs:number|null;transactionId:string;reviews:Array<{raterRole:number;stars:number;reviewedAtMs:number;transactionId:string}>;history:Array<{eventType:string;occurredAtMs:number;sourceEventId:string;status:number|null;digest?:string;verification:"indexer_preview"|"fullnode_unavailable"|"fullnode_mismatch"|"finalized_fullnode_task_event"|"checkpoint_pending_task_event"|"failed_task_transaction"|"fullnode_event_mismatch"|"fullnode_unavailable_or_unknown";checkpoint?:string|null}>;historyEvidence:"participant_indexed_history_with_fullnode_event_checks";historyOffset:number;historyLimit:number;nextHistoryOffset:number|null}
interface TaskRoomResolution {taskId:string;groupId:string;groupUuid:string;evidenceSource:"authorized_task_participant_and_social_indexer_room_binding";messagingPermission:"not_proven_by_this_read"}
type TaskSettlementReceipt={taskId:string;settled:false;status:number;receipt:null;verification:"task_not_indexed_as_settled"}|{taskId:string;settled:true;status:3;receipt:{taskId:string;receiptId:string;transactionId:string;settledAtMs:number};transactionDigest:string;verification:"finalized_fullnode_task_receipt_settled_event"};
type TaskDeliveryReceipt={digest:string;taskId:string;status:"finalized"|"checkpoint_pending"|"failed"|"unknown";uri:string|null;digestHex:string|null;verification:string};
type TaskCancelOfferReceipt={digest:string;taskId:string;status:"finalized"|"checkpoint_pending"|"failed"|"unknown";verification:string};
type View="work"|"marketplace"|"tasks"|"agent_tasks"|"agents"|"jury"|"organization_tasks"|"organizations"|"rooms"|"receipts"|"automations"|"knowledge";
const labels:Record<View,string>={work:"Work",marketplace:"Marketplace",tasks:"My tasks",agent_tasks:"Agent tasks",agents:"Agents",jury:"Jury duties",organization_tasks:"Organization tasks",organizations:"Organizations",rooms:"Rooms",receipts:"Receipts",automations:"Automations",knowledge:"Knowledge"};
const navGroups=[["Work",[["work",Layers3],["marketplace",Store],["tasks",ListTodo]]],["Agents",[["agent_tasks",ClipboardList],["jury",ClipboardList],["agents",Bot],["automations",Clock3]]],["Teams",[["organization_tasks",Briefcase],["organizations",Building2],["rooms",MessageCircle]]],["Records",[["knowledge",BookOpen],["receipts",ReceiptText]]]] as const;
async function api<T>(path:string,init?:RequestInit):Promise<T>{
    const response=await fetch(`/api/myso/${path}`,{...init,cache:"no-store",headers:{...(init?.body?{"Content-Type":"application/json"}:{}),...init?.headers}});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error??"This request could not finish");
    return data as T;
}
async function verifyWorkAgent(client:MySoJsonRpcClient,owner:string,accountId:string,agentId:string,envelope:AgentKeyEnvelopeV1){
    const read=async(id:string)=>{const response=await client.getObject({id,options:{showContent:true}});const content=response.data?.content;if(!content||content.dataType!=="moveObject")throw new Error("Agent custody could not be verified on chain");return{type:content.type,fields:content.fields as Record<string,unknown>};};
    const optional=(value:unknown):unknown=>{if(value==null||typeof value==="string"||typeof value==="number")return value??null;if(typeof value==="object"&&!Array.isArray(value)){const option=value as {vec?:unknown;fields?:{vec?:unknown}};const vec=option.vec??option.fields?.vec;if(Array.isArray(vec)&&vec.length<=1)return vec[0]??null;}throw new Error("The agent has an invalid optional chain field");};
    const agent=await read(agentId);const [pkg,module,type]=agent.type.split("::");const fields=agent.fields;
    const publicKey=Array.isArray(fields.public_key)?fields.public_key.map(byte=>Number(byte).toString(16).padStart(2,"0")).join(""):"";
    if(normalizeKeyAddress(pkg??"")!==envelope.packageId||module!=="memory"||type!=="SubAgent"||publicKey!==envelope.publicKey||fields.active!==true||normalizeKeyAddress(String(fields.memory_account_id))!==normalizeKeyAddress(accountId)||normalizeKeyAddress(String(fields.principal_owner))!==normalizeKeyAddress(owner)||normalizeKeyAddress(String(fields.derived_address))!==envelope.derivedAddress)throw new Error("The local custody key does not match this active agent");
    const expiry=optional(fields.expires_at);if(expiry!=null&&Number(expiry)<Date.now())throw new Error("This agent has expired");
    let parent=optional(fields.parent_object_id);const seen=new Set<string>();
    while(typeof parent==="string"&&parent){const parentId=normalizeKeyAddress(parent);if(seen.has(parentId)||seen.size>=8)throw new Error("The agent ancestry is invalid");seen.add(parentId);const ancestor=await read(parentId);const [ancestorPackage,ancestorModule,ancestorType]=ancestor.type.split("::");if(normalizeKeyAddress(ancestorPackage??"")!==envelope.packageId||ancestorModule!=="memory"||ancestorType!=="SubAgent"||ancestor.fields.active!==true||normalizeKeyAddress(String(ancestor.fields.memory_account_id))!==normalizeKeyAddress(accountId)||normalizeKeyAddress(String(ancestor.fields.principal_owner))!==normalizeKeyAddress(owner))throw new Error("An ancestor agent is inactive or belongs to another account");const ancestorExpiry=optional(ancestor.fields.expires_at);if(ancestorExpiry!=null&&Number(ancestorExpiry)<Date.now())throw new Error("An ancestor agent has expired");parent=optional(ancestor.fields.parent_object_id);}
    const account=await read(accountId);if(account.fields.active!==true||normalizeKeyAddress(String(account.fields.owner))!==normalizeKeyAddress(owner))throw new Error("The Memory account is inactive or its owner changed");
    return{platformScope:null};
}
function date(value:string|number){const parsed=new Date(value);return Number.isNaN(parsed.getTime())?"Date unavailable":parsed.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});}
function sameObjectId(left:unknown,right:unknown){if(typeof left!=="string"||typeof right!=="string"||!/^0x[0-9a-fA-F]{1,64}$/.test(left)||!/^0x[0-9a-fA-F]{1,64}$/.test(right))return false;return left.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===right.replace(/^0x/i,"").toLowerCase().padStart(64,"0");}
function compareDecimal(left:string,right:string){const a=left.replace(/^0+(?=\d)/,"")||"0";const b=right.replace(/^0+(?=\d)/,"")||"0";if(a.length!==b.length)return a.length<b.length?-1:1;return a<b?-1:a>b?1:0;}
function nextDecimal(value:string){return (BigInt(value)+1n).toString();}
function taskReviewRole(task:TaskDetail,context:Context|null):"buyer"|"seller"|null{
    if(!context)return null;
    if(sameObjectId(task.buyerPrincipal,context.scope.owner)&&sameObjectId(task.buyerMemoryAccountId,context.scope.accountId)&&(!task.buyerAgentId||sameObjectId(task.buyerAgentId,context.scope.agentId)))return "buyer";
    if(sameObjectId(task.sellerPrincipal,context.scope.owner)&&sameObjectId(task.sellerMemoryAccountId,context.scope.accountId)&&sameObjectId(task.sellerAgentId,context.scope.agentId))return "seller";
    return null;
}
function status(value:string){return value==="running"?"In progress":value==="yielded"?"Paused at model-turn limit":value.replaceAll("_"," ");}
function title(row:Record<string,unknown>,view:View){
    const dutyStatus=["drafted","accepted","committed","revealed","replaced","defaulted"][Number(row.status)-1]??"status unavailable";
    const dutyKind=typeof row.dutyKind==="string"?row.dutyKind:"no pending action";
    const subject=Number(row.subjectKind)===1?"task dispute":Number(row.subjectKind)===2?"proposal":"case";
    const value=view==="tasks"||view==="agent_tasks"||view==="organization_tasks"||view==="marketplace"?row.title:view==="organizations"?(row.organizationName??row.name??row.organizationId):view==="rooms"?row.groupName:view==="automations"?row.name:view==="jury"?`${subject} · ${String(row.caseId??"unknown")} · ${dutyKind} · ${dutyStatus} · round ${Number(row.round??0)+1}`:undefined;
    return typeof value==="string"&&value?value:view==="receipts"?"Task settlement receipt":view==="rooms"?"Work room":view==="organizations"?"Organization":"Untitled task";
}
function automationTriggerSummary(value:unknown){
    if(!value||typeof value!=="object"||Array.isArray(value))return "Trigger details unavailable";
    const triggers=(value as Record<string,unknown>).triggers;
    if(!Array.isArray(triggers)||!triggers.length)return "No triggers configured";
    return triggers.slice(0,8).map(raw=>{
        if(!raw||typeof raw!=="object"||Array.isArray(raw))return "Unknown trigger";
        const trigger=raw as Record<string,unknown>;
        if(trigger.kind==="event")return `Event · ${typeof trigger.event_family==="string"?trigger.event_family:"unknown"} / ${typeof trigger.event_type==="string"?trigger.event_type:"unknown"}`;
        if(trigger.kind==="cron")return `Schedule · ${typeof trigger.cron_expr==="string"?trigger.cron_expr:"unknown"} · ${typeof trigger.timezone==="string"?trigger.timezone:"UTC"}`;
        if(trigger.kind==="interval")return `Interval · every ${typeof trigger.interval_ms==="number"&&Number.isFinite(trigger.interval_ms)?Math.round(trigger.interval_ms/60000):"?"} min`;
        return `${typeof trigger.kind==="string"?trigger.kind:"Unknown"} trigger`;
    }).join(" · ");
}
function readableMessages(run:WorkRun){
    const entries:Array<{role:string;text:string;key:string}>=[];
    for(const [index,raw] of (run.messages??[]).entries()){
        if(!raw||typeof raw!=="object")continue;
        const message=raw as {role?:string;content?:Array<{type?:string;text?:string;name?:string;arguments?:{question?:string;details?:string}}>};
        if(!["user","assistant"].includes(message.role??"")||!Array.isArray(message.content))continue;
        for(const [partIndex,part] of message.content.entries()){
            const text=part.type==="text"?part.text:part.type==="toolCall"&&part.name==="ask_user_question"?part.arguments?.question:undefined;
            if(text)entries.push({role:message.role!,text,key:`${index}-${partIndex}`});
        }
    }
    return entries;
}
function Workspace(){
    useEffect(()=>{if(navigator.userAgent.includes("Electron")){document.documentElement.classList.add("myso-electron");document.documentElement.dataset.mysoPlatform=window.mysoAgents?.platform??"";}},[]);
    const {resolvedTheme,setTheme}=useTheme();
    const walletAccount=useCurrentAccount();const wallets=useWallets();const walletConnect=useConnectWallet();const personal=useSignPersonalMessage();const signMessageRef=useRef(personal.mutateAsync);signMessageRef.current=personal.mutateAsync;
    const [desktopAuth,setDesktopAuth]=useState(false); const [loginPending,setLoginPending]=useState(false); const [reconnect,setReconnect]=useState(false);
    const [loginPhase,setLoginPhase]=useState<"processing"|"success"|null>(null);
    useEffect(()=>setDesktopAuth(!!window.mysoAgents?.myso),[]);
    useEffect(()=>{if(document.cookie.split("; ").includes("myso_session_reconnect=1"))setReconnect(true);},[]);
    const [context,setContext]=useState<Context|null>(null);const [account,setAccount]=useState<SignedInAccount|null>(null);const [connecting,setConnecting]=useState(true);
    const ownerWalletMatches=!!context&&!!walletAccount&&normalizeKeyAddress(walletAccount.address)===normalizeKeyAddress(context.scope.owner);
    const memoryUrl=process.env.NEXT_PUBLIC_MYSO_MEMORY_URL;
    const custodyNetwork=context&&["mainnet","testnet","devnet","localnet"].includes(context.scope.network)?context.scope.network as "mainnet"|"testnet"|"devnet"|"localnet":null;
    const custodyClient=useMemo(()=>context&&custodyNetwork?new MySoJsonRpcClient({url:context.rpcUrl,network:custodyNetwork}):null,[context?.rpcUrl,custodyNetwork]);
    const workVault=useMemo(()=>{
        if(!context||!custodyClient||!memoryUrl)return null;
        const vault=new CustodyVault(memoryUrl,{accountId:context.scope.accountId,owner:context.scope.owner},async(message)=>{
            if(!walletAccount||normalizeKeyAddress(walletAccount.address)!==normalizeKeyAddress(context.scope.owner))throw new Error("Connect the owner wallet to unlock local agent custody");
            return (await signMessageRef.current({message,chain:`myso:${context.scope.network}`})).signature;
        },(agentId,envelope)=>verifyWorkAgent(custodyClient,context.scope.owner,context.scope.accountId,agentId,envelope));
        vault.setLoginSeedProvider(deriveMySocialLoginSeed);return vault;
    },[context,custodyClient,memoryUrl,walletAccount]);
    const [vaultSnapshot,setVaultSnapshot]=useState(0);const [vaultBusy,setVaultBusy]=useState(false);
    useEffect(()=>{if(!workVault)return;const unsubscribe=workVault.subscribe(()=>setVaultSnapshot(workVault.getSnapshot()));return()=>{unsubscribe();workVault.lock();};},[workVault]);
    void vaultSnapshot;
    async function workSessionHeaders():Promise<HeadersInit>{
        if(!context||!workVault||workVault.status!=="ready")throw new Error("Unlock local agent custody to access encrypted work runs");
        const network=context.scope.network;if(!["mainnet","testnet","devnet","localnet"].includes(network))throw new Error("This MySo network is not supported for encrypted work runs");
        const session=await workVault.exportMyDataSession({agent_object_id:context.scope.agentId,derived_address:context.derivedAddress,organization_id:context.scope.organizationId??null},{rpcUrl:context.rpcUrl,network:network as "mainnet"|"testnet"|"devnet"|"localnet",packageId:context.socialChain.packageId,ttlMin:30});
        if(session.expiresAtMs<=Date.now())throw new Error("The short-lived MyData session expired; unlock custody again");
        return {"x-mydata-session":session.session};
    }
    async function workApi<T>(path:string,init?:RequestInit):Promise<T>{return api<T>(path,{...init,headers:{...init?.headers,...await workSessionHeaders()}});}
    async function unlockWorkCustody(){
        if(!workVault)return;setVaultBusy(true);setError("");
        try{await workVault.unlock({method:PRIMARY_CUSTODY});await refresh();const value=await workApi<{tools:Tool[];models:Model[]}>("catalog");setTools(value.tools);setModels(value.models.filter(model=>model.supports_tools&&model.context_length&&model.max_output_tokens));}
        catch(reason){setError(reason instanceof Error?reason.message:"Local custody could not be unlocked");}
        finally{setVaultBusy(false);}
    }
    function rememberSession(value:ContextResponse){
        if(value.scope&&value.derivedAddress&&value.rpcUrl&&value.socialChain)setContext({scope:value.scope,label:value.label,derivedAddress:value.derivedAddress,rpcUrl:value.rpcUrl,socialChain:value.socialChain});
        const owner=value.scope?.owner??value.owner;
        if(value.scope||value.signedIn||owner)setAccount({owner,label:value.label});
    }
    const [retrying,setRetrying]=useState(false);
    async function retryContext(){
        setRetrying(true);setError("");
        try{rememberSession(await api<ContextResponse>("context"));}
        catch(reason){setError((reason as Error).message);}finally{setRetrying(false);}
    }
    const [view,setView]=useState<View>("work");const [runs,setRuns]=useState<Summary[]>([]);const [run,setRun]=useState<WorkRun|null>(null);
    const [items,setItems]=useState<Record<string,unknown>[]>([]);const [offset,setOffset]=useState(0);const [role,setRole]=useState("seller");
    const [marketStats,setMarketStats]=useState<TaskMarketStats|null>(null);
    const [marketSellers,setMarketSellers]=useState<TaskMarketSeller[]>([]);
    const [marketSellerOffset,setMarketSellerOffset]=useState(0);
    const [acceptingTask,setAcceptingTask]=useState<string|null>(null);const [acceptedSubmission,setAcceptedSubmission]=useState<{taskId:string;digest:string}|null>(null);const [acceptReceipt,setAcceptReceipt]=useState<TaskAcceptReceipt|null>(null);const [acceptReceiptLoading,setAcceptReceiptLoading]=useState(false);
    const [reviewStars,setReviewStars]=useState(5);const [reviewSubmission,setReviewSubmission]=useState<TaskReviewResult|null>(null);const [reviewReceipt,setReviewReceipt]=useState<TaskReviewReceipt|null>(null);const [reviewReceiptLoading,setReviewReceiptLoading]=useState(false);
    const [cancellingTask,setCancellingTask]=useState<string|null>(null);const [cancelOfferSubmission,setCancelOfferSubmission]=useState<{taskId:string;digest:string}|null>(null);const [cancelOfferReceipt,setCancelOfferReceipt]=useState<TaskCancelOfferReceipt|null>(null);const [cancelOfferReceiptLoading,setCancelOfferReceiptLoading]=useState(false);
    const [bindingTaskRoom,setBindingTaskRoom]=useState<string|null>(null);const [roomBindingSubmission,setRoomBindingSubmission]=useState<TaskRoomBindResult|null>(null);
    const [settlingTask,setSettlingTask]=useState<string|null>(null);const [settlementSubmission,setSettlementSubmission]=useState<{taskId:string;digest:string}|null>(null);
    const [deliveryUri,setDeliveryUri]=useState("");const [deliveryDigest,setDeliveryDigest]=useState("");const [uploadingTask,setUploadingTask]=useState<string|null>(null);const [deliveryFiles,setDeliveryFiles]=useState<File[]>([]);const [deliveryUploadAckKey,setDeliveryUploadAckKey]=useState("");const [deliveringTask,setDeliveringTask]=useState<string|null>(null);const [deliverySubmission,setDeliverySubmission]=useState<{taskId:string;digest:string;uri:string;digestHex:string}|null>(null);const [deliveryReceipt,setDeliveryReceipt]=useState<TaskDeliveryReceipt|null>(null);const [deliveryReceiptLoading,setDeliveryReceiptLoading]=useState(false);
    const [selectedTask,setSelectedTask]=useState<TaskDetail|null>(null);const [taskLoading,setTaskLoading]=useState(false);const [taskHistoryLoading,setTaskHistoryLoading]=useState(false);const [taskSettlement,setTaskSettlement]=useState<TaskSettlementReceipt|null>(null);const [taskSettlementLoading,setTaskSettlementLoading]=useState(false);
    const [selectedRoom,setSelectedRoom]=useState<Record<string,unknown>|null>(null);const [roomViewKey,setRoomViewKey]=useState(0);const [roomHistory,setRoomHistory]=useState<RoomHistoryPage|null>(null);const [roomHistoryLoading,setRoomHistoryLoading]=useState(false);const roomHistoryRequest=useRef(0);
    const [roomReceipts,setRoomReceipts]=useState<RoomReceipts|null>(null);const [roomReceiptsLoading,setRoomReceiptsLoading]=useState(false);const [roomReceiptUpdating,setRoomReceiptUpdating]=useState(false);const roomReceiptRequest=useRef(0);
    const [roomMemberGroupId,setRoomMemberGroupId]=useState<string|null>(null);const [roomMembers,setRoomMembers]=useState<RoomMemberPage|null>(null);const [roomMembersLoading,setRoomMembersLoading]=useState(false);const roomMembersRequest=useRef(0);const [roomRenamingGroupId,setRoomRenamingGroupId]=useState<string|null>(null);const [roomArchivingGroupId,setRoomArchivingGroupId]=useState<string|null>(null);
    const [roomInviteAddress,setRoomInviteAddress]=useState("");const [roomInviteAckGroupId,setRoomInviteAckGroupId]=useState<string|null>(null);const [roomInvitingGroupId,setRoomInvitingGroupId]=useState<string|null>(null);const [roomInviteResult,setRoomInviteResult]=useState<RoomInviteResult|null>(null);
    const [roomRemovalTarget,setRoomRemovalTarget]=useState<{uuid:string;groupId:string;member:string}|null>(null);const [roomRemovalAcknowledged,setRoomRemovalAcknowledged]=useState(false);const [roomRemovingGroupId,setRoomRemovingGroupId]=useState<string|null>(null);const [roomRemovalResult,setRoomRemovalResult]=useState<RoomRemovalResult|null>(null);const [roomBulkRemoval,setRoomBulkRemoval]=useState<{groupId:string;member:string}|null>(null);
    const [artifactLoading,setArtifactLoading]=useState<string|null>(null);const [deliveryCheck,setDeliveryCheck]=useState<DeliveryCheck|null>(null);
    const [automationDeliveryJob,setAutomationDeliveryJob]=useState<string|null>(null);const [automationDeliveries,setAutomationDeliveries]=useState<AutomationDelivery[]>([]);const [automationDeliveryLoading,setAutomationDeliveryLoading]=useState(false);const [automationDeliveryNextOffset,setAutomationDeliveryNextOffset]=useState<number|null>(null);const [automationReconcileNotes,setAutomationReconcileNotes]=useState<Record<string,string>>({});
    const [editingAutomation,setEditingAutomation]=useState<{id:string;version:number;name:string;triggerSet:Record<string,unknown>;action:AutomationJobConfiguration["action"]}|null>(null);
    const [automationRunJob,setAutomationRunJob]=useState<string|null>(null);const [automationRuns,setAutomationRuns]=useState<AutomationRun[]>([]);const [automationRunLoading,setAutomationRunLoading]=useState(false);const [automationRunNextOffset,setAutomationRunNextOffset]=useState<number|null>(null);const [automationRunReconcileNotes,setAutomationRunReconcileNotes]=useState<Record<string,string>>({});const [automationRunResolving,setAutomationRunResolving]=useState<string|null>(null);
    const [automationDelegates,setAutomationDelegates]=useState<AutomationDelegate[]|null>(null);const [automationDelegateLoading,setAutomationDelegateLoading]=useState(false);const [automationDelegateCursor,setAutomationDelegateCursor]=useState<string|null>(null);const [automationDelegateHasNext,setAutomationDelegateHasNext]=useState(false);
    const [automationDelegateKeyEvents,setAutomationDelegateKeyEvents]=useState<AutomationDelegateKeyEvent[]|null>(null);const [automationDelegateKeyEventLoading,setAutomationDelegateKeyEventLoading]=useState(false);const [automationDelegateKeyEventCursor,setAutomationDelegateKeyEventCursor]=useState<string|null>(null);const [automationDelegateKeyEventHasNext,setAutomationDelegateKeyEventHasNext]=useState(false);
    const [models,setModels]=useState<Model[]>([]);const [tools,setTools]=useState<Tool[]>([]);const [modelId,setModelId]=useState("");const [roomHistoryConsentRunId,setRoomHistoryConsentRunId]=useState<string|null>(null);const [privateGraphConsentRunId,setPrivateGraphConsentRunId]=useState<string|null>(null);const [privateTaskArtifactConsentRunId,setPrivateTaskArtifactConsentRunId]=useState<string|null>(null);const [privateContentShareConsentRunId,setPrivateContentShareConsentRunId]=useState<string|null>(null);
    const [runTaskHistoryRefreshing,setRunTaskHistoryRefreshing]=useState(false);
    const [runAiUsage,setRunAiUsage]=useState<RunAiUsage|null>(null);const [runAiUsageLoading,setRunAiUsageLoading]=useState(false);
    const [runOperationJournal,setRunOperationJournal]=useState<RunOperationJournal|null>(null);const [runOperationJournalLoading,setRunOperationJournalLoading]=useState(false);
    const [runOperationReceipts,setRunOperationReceipts]=useState<Record<string,RunOperationReceipt>>({});const [runOperationReceiptLoading,setRunOperationReceiptLoading]=useState<string|null>(null);
    const [goal,setGoal]=useState("");const [criterion,setCriterion]=useState("");const [input,setInput]=useState("");const [pendingTaskId,setPendingTaskId]=useState<string|undefined>();const [pendingTaskRole,setPendingTaskRole]=useState<"buyer"|"seller"|undefined>();const [pendingTaskOffered,setPendingTaskOffered]=useState(false);
    const [sidebar,setSidebar]=useState<"expanded"|"collapsed">("expanded");const [sidebarAnimated,setSidebarAnimated]=useState(false);const [mobileNav,setMobileNav]=useState(false);
    useEffect(()=>{try{if(localStorage.getItem("myso-agents:sidebar")==="collapsed")setSidebar("collapsed");}catch{}},[]);
    const toggleSidebar=useCallback(()=>{setSidebarAnimated(true);setSidebar(current=>{const next=current==="expanded"?"collapsed":"expanded";try{localStorage.setItem("myso-agents:sidebar",next);}catch{}return next;});},[]);
    useEffect(()=>{
        const onKeyDown=(event:KeyboardEvent)=>{
            if(!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=="o"||event.altKey||event.shiftKey)return;
            const target=event.target;
            if(target instanceof HTMLElement&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))return;
            event.preventDefault();
            toggleSidebar();
        };
        window.addEventListener("keydown",onKeyDown);
        return()=>window.removeEventListener("keydown",onKeyDown);
    },[toggleSidebar]);
    useEffect(()=>{if(!mobileNav)return;const onKeyDown=(event:KeyboardEvent)=>{if(event.key==="Escape")setMobileNav(false);};window.addEventListener("keydown",onKeyDown);return()=>window.removeEventListener("keydown",onKeyDown);},[mobileNav]);
    const [error,setError]=useState("");const [notice,setNotice]=useState("");const [busy,setBusy]=useState(false);const [loading,setLoading]=useState(false);const [creating,setCreating]=useState(false);const [cancelingRun,setCancelingRun]=useState<string|null>(null);const [completingRun,setCompletingRun]=useState<string|null>(null);
    useEffect(()=>{
        const onKeyDown=(event:KeyboardEvent)=>{
            if(!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=="n"||event.altKey||event.shiftKey)return;
            const target=event.target;
            if(target instanceof HTMLElement&&(target.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))return;
            event.preventDefault();
            setView("work");
            setRun(null);
            setCreating(workVault?.status==="ready");
        };
        window.addEventListener("keydown",onKeyDown);
        return()=>window.removeEventListener("keydown",onKeyDown);
    },[workVault]);
    const requestCounter=useRef(0);const pendingCreate=useRef<{id:string;plan:object;taskId?:string}|null>(null);const taskDetailRequest=useRef(0);const taskReceiptRequest=useRef(0);const runSelectionEpoch=useRef(0);const restoredRunScope=useRef<string|null>(null);
    const runSelectionKey=context?`myso-agents:last-run:${context.socialChain}:${context.scope.owner.toLowerCase()}:${context.scope.agentId.toLowerCase()}`:null;
    const refresh=useCallback(async()=>{
        const generation=++requestCounter.current;setLoading(true);setError("");
        if(view==="marketplace"){setMarketStats(null);setMarketSellers([]);}
        try{
            if(view==="work"){
                if(!workVault||workVault.status!=="ready"){setRuns([]);return;}
                const data=await workApi<{runs:Summary[]}>(`runs?limit=20&offset=${offset}`);
                if(generation===requestCounter.current)setRuns(data.runs);
            }else if(view!=="knowledge"&&view!=="agents"){
                const data=await api<{items:Record<string,unknown>[]}>(`views/${view}?offset=${offset}&role=${role}`);
                if(generation===requestCounter.current)setItems(data.items);
                if(view==="marketplace"){
                    try{const stats=await api<TaskMarketStats>("task-market/stats");if(generation===requestCounter.current)setMarketStats(stats);}
                    catch{if(generation===requestCounter.current)setMarketStats(null);}
                    try{const sellers=await api<{items:TaskMarketSeller[]}>(`task-market/sellers?sort=score&min_reviews=0&limit=20&offset=${marketSellerOffset}`);if(generation===requestCounter.current)setMarketSellers(sellers.items);}
                    catch{if(generation===requestCounter.current)setMarketSellers([]);}
                }
            }
        }catch(reason){if(generation===requestCounter.current)setError(reason instanceof Error?reason.message:"Unable to load this view");}
        finally{if(generation===requestCounter.current)setLoading(false);}
    },[view,offset,role,marketSellerOffset,workVault,vaultSnapshot]);
    useEffect(()=>{
        let alive=true;
        void api<ContextResponse>("context").then(value=>{if(alive){document.cookie="myso_session_reconnect=; Max-Age=0; Path=/";setReconnect(false);rememberSession(value);}}).catch(reason=>{if(!alive)return;if(reason.message==="Reconnect your MySo account"){setReconnect(true);return;}if(reason.message!=="Connect your MySo account to continue")setError(reason.message);}).finally(()=>{if(alive)setConnecting(false);});
        return()=>{alive=false;};
    },[]);
    useEffect(()=>{if(error!=="Reconnect your MySo account")return;setReconnect(true);setContext(null);setAccount(null);setError("");},[error]);
    useEffect(()=>{if(context)void refresh();},[context,refresh]);
    useEffect(()=>{
        if(view!=="work"||workVault?.status!=="ready")return;
        const active=run?(["running","reconciling"].includes(run.status)):
            runs.some(item=>["running","reconciling"].includes(item.status));
        if(!active)return;
        let alive=true;
        const timer=window.setInterval(()=>{
            if(run){
                void workApi<WorkRun>(`runs/${encodeURIComponent(run.id)}`).then(value=>{
                    if(alive)setRun(current=>current?.id===value.id?value:current);
                }).catch(()=>{});
            }else{
                void workApi<{runs:Summary[]}>(`runs?limit=20&offset=${offset}`).then(value=>{
                    if(alive)setRuns(value.runs);
                }).catch(()=>{});
            }
        },5000);
        return()=>{alive=false;window.clearInterval(timer);};
    },[view,workVault?.status,run?.id,run?.status,runs,offset]);
    useEffect(()=>{
        if(!context||!runSelectionKey||workVault?.status!=="ready"||restoredRunScope.current===runSelectionKey)return;
        restoredRunScope.current=runSelectionKey;
        const saved=sessionStorage.getItem(runSelectionKey);
        if(!saved)return;
        const epoch=runSelectionEpoch.current;
        let alive=true;
        void workApi<WorkRun>(`runs/${encodeURIComponent(saved)}`).then(value=>{
            if(alive&&runSelectionEpoch.current===epoch){setRun(value);setCreating(false);setView("work");}
        }).catch(()=>{
            // Keep the saved reference on transient errors; the run list remains the recovery path.
        });
        return()=>{alive=false;};
    },[context,runSelectionKey,workVault,vaultSnapshot]);
    useEffect(()=>{
        if(!context)return;let alive=true;
        void (workVault?.status==="ready"?workApi<{tools:Tool[];models:Model[]}>("catalog"):api<{tools:Tool[];models:Model[]}>("catalog")).then(value=>{
            if(!alive)return;setTools(value.tools);setModels(value.models.filter(model=>model.supports_tools&&model.context_length&&model.max_output_tokens));
        }).catch(reason=>{if(alive)setError(reason.message);});
        return()=>{alive=false;};
    },[context,workVault,vaultSnapshot]);
    const [pendingApprovals,setPendingApprovals]=useState(0);
    useEffect(()=>{
        if(!context)return;let alive=true;
        // Count only; the Agents view owns the approval flow. A failed count hides the pill rather than guessing.
        void api<{items?:unknown[]}>("action-approvals",{method:"POST",body:JSON.stringify({operation:"list"})}).then(value=>{if(alive)setPendingApprovals(value.items?.length??0);}).catch(()=>{if(alive)setPendingApprovals(0);});
        return()=>{alive=false;};
    },[context,view]);
    async function connectDesktop(){
        if(!window.mysoAgents?.myso)return;setLoginPending(true);setError("");
        try{const result=await window.mysoAgents.myso.connect();if(result.connected&&result.custodyAccessToken){setCustodyAccessToken(result.custodyAccessToken);rememberSession(await api<ContextResponse>("context"));}else if(!result.cancelled)setError(result.error??"MySo account connection did not finish");}
        catch{setError("MySo account connection could not finish; try again when ready");}
        finally{setLoginPending(false);}
    }
    async function connectHosted(){
        setLoginPending(true);setLoginPhase(null);setError("");
        try{
            const token=await signInWithMySocial({onAuthWindowClosed:()=>setLoginPhase("processing")});
            setCustodyAccessToken(token);
            rememberSession(await api<ContextResponse>("context"));
            setLoginPhase("success");
            await new Promise((resolve)=>window.setTimeout(resolve,LOGIN_SUCCESS_HOLD_MS));
        }
        catch(reason){setLoginPhase(null);setError(reason instanceof Error?reason.message:"MySo account connection could not finish");}
        finally{setLoginPending(false);setLoginPhase(null);}
    }
    async function refreshCustodySession(){
        setLoginPending(true);setError("");
        try{
            if(window.mysoAgents?.myso){
                const result=await window.mysoAgents.myso.connect();
                if(!result.connected||!result.custodyAccessToken)throw new Error(result.error??"MySo account connection did not finish");
                setCustodyAccessToken(result.custodyAccessToken);
            }else setCustodyAccessToken(await signInWithMySocial());
        }finally{setLoginPending(false);}
    }
    async function backfillTaskHistory(runId:string){
        setRunTaskHistoryRefreshing(true);setError("");setNotice("");
        try{
            let latest:WorkRun|null=null;let truncated=false;let complete=false;
            for(let page=0;page<100&&!complete&&!truncated;page+=1){
                const result=await workApi<{run:WorkRun;added:number;complete:boolean;truncated:boolean}>(`runs/${encodeURIComponent(runId)}/task-history/refresh`,{method:"POST",body:JSON.stringify({})});
                latest=result.run;truncated=result.truncated;complete=result.complete||result.added===0;
            }
            if(latest)setRun(current=>current?.id===runId?latest:current);
            if(truncated)setNotice("Task history reached the 10,000-event journal limit; the saved history is marked as truncated.");
        }catch(reason){setError(reason instanceof Error?reason.message:"Task history could not be refreshed");}
        finally{setRunTaskHistoryRefreshing(false);}
    }
    async function selectRun(id:string){runSelectionEpoch.current++;setBusy(true);setError("");try{const value=await workApi<WorkRun>(`runs/${encodeURIComponent(id)}`);setRun(value);setCreating(false);if(runSelectionKey)sessionStorage.setItem(runSelectionKey,value.id);if(value.taskId)void backfillTaskHistory(value.id);}catch(reason){setError((reason as Error).message);}finally{setBusy(false);}}
    async function refreshRunTaskHistory(){if(!run?.taskId||runTaskHistoryRefreshing)return;await backfillTaskHistory(run.id);}
    async function loadRunAiUsage(){
        if(!run||runAiUsageLoading)return;
        const runId=run.id;setRunAiUsageLoading(true);setError("");
        try{const usage=await workApi<RunAiUsage>(`runs/${encodeURIComponent(runId)}/ai-usage`);if(usage.runId!==runId)throw new Error("AI usage belongs to a different work run");setRunAiUsage(usage);}
        catch(reason){setError(reason instanceof Error?reason.message:"AI usage could not be loaded");}
        finally{setRunAiUsageLoading(false);}
    }
    async function loadRunOperationJournal(){
        if(!run||runOperationJournalLoading)return;
        const runId=run.id;setRunOperationJournalLoading(true);setError("");
        try{
            const journal=await workApi<RunOperationJournal>(`runs/${encodeURIComponent(runId)}/operations`);
            if(journal.runId!==runId||journal.complete!==true||journal.verification!=="scoped_encrypted_work_operation_journal")throw new Error("Recovery records do not match this work run");
            setRunOperationJournal(journal);
        }catch(reason){setError(reason instanceof Error?reason.message:"Work-run recovery records could not be loaded");}
        finally{setRunOperationJournalLoading(false);}
    }
    async function verifyRunOperationReceipt(operationId:string){
        if(!run||runOperationReceiptLoading)return;
        const runId=run.id;setRunOperationReceiptLoading(operationId);setError("");
        try{
            const evidence=await workApi<RunOperationReceipt>(`runs/${encodeURIComponent(runId)}/operations/${encodeURIComponent(operationId)}/receipt`,{method:"POST",body:JSON.stringify({confirmed:true})});
            if(evidence.runId!==runId||evidence.operationId!==operationId)throw new Error("Receipt evidence belongs to a different work operation");
            setRunOperationReceipts(current=>({...current,[operationId]:evidence}));
            if(evidence.receipt?.status==="finalized")setNotice(`Operation ${operationId} was resolved from its finalized registered action receipt. Continue the run to resume coordination.`);
            else if(evidence.receipt?.status==="failed")setNotice(`Operation ${operationId} was resolved as failed from its registered fullnode receipt. Continue the run to let the coordinator handle the failure.`);
            else if(evidence.recoveredUpload)setNotice(`The saved task upload ${evidence.recoveredUpload.digestHex} was verified against the participant ledger and R2. Continue the run to attach it and resume coordination.`);
            await loadRunOperationJournal();
        }catch(reason){setError(reason instanceof Error?reason.message:"The registered action receipt could not be verified");}
        finally{setRunOperationReceiptLoading(null);}
    }
    async function retryRunOperationUpload(operationId:string,file:File){
        if(!run||runOperationReceiptLoading)return;
        if(file.size<1||file.size>512*1024){setError("Choose the exact original artifact file (1–512 KiB).");return;}
        const runId=run.id;setRunOperationReceiptLoading(operationId);setError("");
        try{
            const bytes=new Uint8Array(await file.arrayBuffer());let binary="";for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(offset+0x8000,bytes.length)));
            const contentBase64=btoa(binary);
            const evidence=await workApi<RunOperationReceipt>(`runs/${encodeURIComponent(runId)}/operations/${encodeURIComponent(operationId)}/receipt`,{method:"POST",body:JSON.stringify({contentBase64})});
            if(evidence.runId!==runId||evidence.operationId!==operationId)throw new Error("Recovered upload belongs to a different work operation");
            setRunOperationReceipts(current=>({...current,[operationId]:evidence}));
            if(evidence.recoveredUpload)setNotice(`The exact artifact retry was verified in R2 for task ${evidence.recoveredUpload.taskId}. Continue the run to attach it and resume coordination.`);
            else setNotice(`The selected bytes did not complete recovery. The saved digest remains ${evidence.retry?.digestHex??evidence.verification}.`);
            await loadRunOperationJournal();
        }catch(reason){setError(reason instanceof Error?reason.message:"The exact artifact retry could not be verified");}
        finally{setRunOperationReceiptLoading(null);}
    }
    async function cancelCurrentRun(){
        if(!run||cancelingRun===run.id||run.cancelRequestedAt)return;
        if(!window.confirm("Stop this work run? Any action already sent may still complete. Uncertain actions will remain held for receipt review."))return;
        const runId=run.id;setCancelingRun(runId);setError("");setNotice("");
        try{
            const result=await workApi<{status:string;cancelRequested:boolean;reconciliationRequired:boolean}>(`runs/${encodeURIComponent(runId)}/cancel`,{method:"POST",body:JSON.stringify({confirmed:true})});
            setNotice(result.reconciliationRequired?"Cancellation requested. An action has an uncertain outcome and remains held for reconciliation.":result.status==="cancelled"?"Work run cancelled.":"Cancellation requested. The active worker will stop at its next lease check.");
            const updated=await workApi<WorkRun>(`runs/${encodeURIComponent(runId)}`);setRun(current=>current?.id===runId?updated:current);await refresh();
        }catch(reason){setError(reason instanceof Error?reason.message:"This work run could not be cancelled");}
        finally{setCancelingRun(null);}
    }
    async function completeCurrentRun(){
        if(!run||completingRun===run.id||!["planned","running","yielded","waiting_for_input","waiting_for_approval"].includes(run.status)||run.plan.steps.length===0||run.plan.steps.some(step=>run.stepStatus[step.id]!=="succeeded"))return;
        if(!window.confirm("Complete this work run? Every plan step is recorded with durable evidence. This will close the harness run; task delivery and escrow settlement remain separate."))return;
        const runId=run.id;setCompletingRun(runId);setError("");setNotice("");
        try{
            const completed=await workApi<WorkRun>(`runs/${encodeURIComponent(runId)}/complete`,{method:"POST",body:JSON.stringify({confirmed:true})});
            if(completed.id!==runId||completed.status!=="completed")throw new Error("The work service did not confirm completion");
            setRun(current=>current?.id===runId?completed:current);setNotice("Work run completed. Marketplace delivery and settlement remain separate task transitions.");await refresh();
        }catch(reason){setError(reason instanceof Error?reason.message:"This work run could not be completed. Check for unresolved actions or evidence gaps.");}
        finally{setCompletingRun(null);}
    }
    async function startTaskCoordination(task:TaskDetail){
        const buyer=sameObjectId(task.buyerPrincipal,context?.scope.owner)&&(!task.buyerAgentId||sameObjectId(task.buyerAgentId,context?.scope.agentId));
        const seller=sameObjectId(task.sellerPrincipal,context?.scope.owner)&&sameObjectId(task.sellerAgentId,context?.scope.agentId);
        const buyerCanCoordinate=buyer&&(task.status===0||task.status===1);
        const sellerCanCoordinate=seller&&task.status===1;
        if((!buyerCanCoordinate&&!sellerCanCoordinate)||!task.roomGroupId||!task.buyerAgentId||!context)return;
        setBusy(true);setError("");setNotice("");
        try{
            const network=context.scope.network as "mainnet"|"testnet"|"devnet"|"localnet";
            const chain=new MySoJsonRpcClient({url:context.rpcUrl,network});
            const agentResult=await chain.getObject({id:task.buyerAgentId,options:{showContent:true}});
            const agentContent=agentResult.data?.content;
            if(!agentContent||agentContent.dataType!=="moveObject")throw new Error("The task buyer agent cannot be verified on chain.");
            const [packageId,module,type]=agentContent.type.split("::");const fields=agentContent.fields as Record<string,unknown>;
            const buyerActor=typeof fields.derived_address==="string"?fields.derived_address:"";
            if(!sameObjectId(packageId,context.socialChain.packageId)||module!=="memory"||type!=="SubAgent"||fields.active!==true||!sameObjectId(String(fields.memory_account_id),task.buyerMemoryAccountId)||!sameObjectId(String(fields.principal_owner),task.buyerPrincipal)||!/^0x[0-9a-fA-F]{1,64}$/.test(buyerActor))throw new Error("The task buyer agent object does not match the indexed task identity.");
            const room=await api<TaskRoomResolution>(`tasks/${encodeURIComponent(task.taskId)}/room`);
            if(!sameObjectId(room.taskId,task.taskId)||!sameObjectId(room.groupId,task.roomGroupId))throw new Error("The resolved room reference does not match the task's linked room.");
            const roomUuid=room.groupUuid;
            const scopeDigest=task.scopeDigestHex.replace(/^0x/i,"").toLowerCase();
            let cursor:RoomHistoryPage["nextCursor"]=null;let verifiedScope:ReturnType<typeof mySoTaskScopeSchema.parse>|null=null;const seenCursors=new Set<string>();
            for(let pageIndex=0;pageIndex<50&&!verifiedScope;pageIndex++){
                const query=new URLSearchParams({limit:"50"});
                if(cursor)for(const [key,value] of Object.entries(cursor))query.set(key,String(value));
                const page=await api<RoomHistoryPage>(`rooms/${encodeURIComponent(roomUuid)}/history?${query}`);
                if(!sameObjectId(page.groupId,task.roomGroupId))throw new Error("The encrypted history belongs to a different room.");
                for(const entry of page.entries){
                    if(entry.status!=="verified_content"||!sameObjectId(entry.content.senderAddress,buyerActor))continue;
                    let parsed:unknown;try{parsed=JSON.parse(entry.content.text);}catch{continue;}
                    const candidate=mySoTaskScopeSchema.safeParse(parsed);if(!candidate.success||candidate.data.title!==task.title)continue;
                    const canonical=JSON.stringify(candidate.data);const actualDigest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(canonical))),byte=>byte.toString(16).padStart(2,"0")).join("");
                    if(actualDigest===scopeDigest){verifiedScope=candidate.data;break;}
                }
                if(verifiedScope||!page.hasNext)break;
                if(!page.nextCursor)throw new Error("Encrypted task history returned an incomplete cursor.");
                const key=JSON.stringify(page.nextCursor);if(seenCursors.has(key))throw new Error("Encrypted task history repeated a cursor.");seenCursors.add(key);cursor=page.nextCursor;
            }
            if(!verifiedScope)throw new Error("No signature-verified buyer scope matched the task’s on-chain digest. Work was not started.");
            const offeredBuyer=buyer&&task.status===0;
            setPendingTaskId(task.taskId);setPendingTaskRole(buyer?"buyer":"seller");setPendingTaskOffered(offeredBuyer);setGoal(`${offeredBuyer?"Coordinate marketplace offer through settlement as buyer":buyer?"Coordinate accepted marketplace task as buyer":"Fulfill accepted marketplace task as seller"}: ${verifiedScope.title}\n\n${verifiedScope.scope}`);setCriterion(verifiedScope.acceptanceCriteria);setSelectedTask(null);setRun(null);setView("work");setCreating(true);
        }catch(reason){setError(reason instanceof Error?reason.message:"The private task scope could not be verified.");}
        finally{setBusy(false);}
    }
    function startGraphPurchase(request:{mydataId:string,graphId:string,graphVersion:number,manifestHashHex:string,publicationSignatureHex:string,audienceKind:"agent"|"organization",organizationAudienceId?:string,priceMist:string,accessKind:2|3,durationDays:string,offerTerms:{revocationPolicy:"one_time_perpetual"|"subscription_period_end"|"subscription_early_future_only",entitlement:"pinned_version"}}){
        const audience=request.audienceKind==="agent"?"this connected agent":`organization ${request.organizationAudienceId}`;
        const access=request.accessKind===2?"one-time immutable snapshot":`${request.durationDays}-day subscription`;
        const revocation=request.offerTerms.revocationPolicy==="one_time_perpetual"?"one-time access is perpetual for this version except fraud or platform-policy enforcement":request.offerTerms.revocationPolicy==="subscription_period_end"?"access ends when the paid subscription period ends":"the seller may end future subscription access early; already fetched content cannot be withdrawn";
        const entitlement="only the named immutable graph version is included; later versions require a separate offer and purchase";
        setPendingTaskId(undefined);
        setGoal(`Purchase and verify private knowledge graph ${request.graphId} v${request.graphVersion} for ${audience}`);
        setCriterion(`The owner explicitly accepted signed seller publication ${request.publicationSignatureHex} and these terms before dispatch: ${revocation}; ${entitlement}. Verify the live signed offer and exact on-chain quote for MyData listing ${request.mydataId}; preserve manifest ${request.manifestHashHex}; use only the selected ${audience} audience. Spend the authenticated agent's own MYSO coin automatically when live on-chain permissions authorize the action and the per-action cap covers the exact ${access} price; this applies to both agent and organization audiences and does not require owner approval. Reconcile the transaction and verify its purchase receipt before reporting access. If on-chain authorization requires owner approval, do not change audiences or broaden policy; show the exact owner-wallet approval route for the human to sign. Do not copy private graph content into work messages or model context.`);
        setInput(`Purchase MyData listing ${request.mydataId}, graph ${request.graphId} version ${request.graphVersion} (manifest ${request.manifestHashHex}), for ${audience}. Use the exact live quote for ${request.priceMist} MIST and ${access}. Explicit audience: ${request.audienceKind}${request.organizationAudienceId?` (${request.organizationAudienceId})`:""}. The owner explicitly accepted seller publication ${request.publicationSignatureHex} and these signed terms: ${revocation}; ${entitlement}. Verify that exact seller proof and quote, list this agent's own MYSO funding coins, then execute automatically only when the live on-chain capability, approval policy and per-action cap authorize the purchase. Organization audience purchases use the agent's funds under that same on-chain policy and require no owner signature. If on-chain authorization requires owner approval, stop the automated attempt and surface the exact owner-wallet approval route; never retry with another audience. Verify the scoped finalized receipt. Do not read or copy graph contents into this work run.`);
        setRun(null);setView("work");setCreating(true);setError("");
    }
    async function toggleAutomation(item:Record<string,unknown>){
        if(typeof item.id!=="string"||typeof item.enabled!=="boolean"||typeof item.version!=="number")return;
        setBusy(true);setError("");
        try{
            const result=await api<{enabled:boolean;version:number}>(`automations/${encodeURIComponent(item.id)}`,{method:"POST",body:JSON.stringify({expected_version:item.version,enabled:!item.enabled})});
            setItems(current=>current.map(row=>row.id===item.id?{...row,enabled:result.enabled,version:result.version}:row));
        }catch(reason){setError(reason instanceof Error?reason.message:"This automation could not be updated");}
        finally{setBusy(false);}
    }
    async function cancelAutomation(item:Record<string,unknown>){
        if(typeof item.id!=="string"||typeof item.version!=="number")return;
        if(!window.confirm("Stop this automation and cancel deliveries that have not started dispatch? Already-running or uncertain actions cannot be aborted and may still complete."))return;
        const note=window.prompt("Add a note to the cancellation history (at least 8 characters).")?.trim();if(!note||note.length<8)return;
        setBusy(true);setError("");setNotice("");
        try{
            const result=await api<{version:number;cancelledPending:number;inFlight:number}>(`automations/${encodeURIComponent(item.id)}/cancel`,{method:"POST",body:JSON.stringify({expected_version:item.version,note,confirmed:true})});
            setItems(current=>current.map(row=>row.id===item.id?{...row,enabled:false,version:result.version}:row));
            setNotice(`Automation stopped. ${result.cancelledPending} queued delivery${result.cancelledPending===1?" was":"ies were"} cancelled; ${result.inFlight} already-claimed or uncertain delivery${result.inFlight===1?" needs":"ies need"} review.`);
        }catch(reason){setError(reason instanceof Error?reason.message:"This automation could not be stopped. Refresh it before retrying.");}
        finally{setBusy(false);}
    }
    async function renameAutomation(item:Record<string,unknown>){
        if(typeof item.id!=="string"||typeof item.name!=="string"||typeof item.version!=="number")return;
        const name=window.prompt("Rename automation",item.name)?.trim();if(!name||name===item.name)return;
        setBusy(true);setError("");
        try{const updated=await api<Record<string,unknown>>(`automations/${encodeURIComponent(item.id)}`,{method:"PATCH",body:JSON.stringify({expected_version:item.version,name})});setItems(current=>current.map(row=>row.id===item.id?{...row,...updated}:row));}
        catch(reason){setError(reason instanceof Error?reason.message:"This automation could not be renamed");}
        finally{setBusy(false);}
    }
    function editAutomationConfiguration(item:Record<string,unknown>){
        if(typeof item.id!=="string"||typeof item.name!=="string"||typeof item.version!=="number")return;
        if(item.enabled!==false){setError("Pause this automation before editing its triggers or action.");return;}
        const triggerSet=item.trigger_set;const action=item.action;
        if(!triggerSet||typeof triggerSet!=="object"||Array.isArray(triggerSet)||!action||typeof action!=="object"||Array.isArray(action)){
            setError("This automation's current configuration is unavailable. Refresh the automation list before editing.");return;
        }
        const candidate=action as Record<string,unknown>;
        if(!(candidate.kind==="memory_relayer_call"||candidate.kind==="registered_action"||candidate.kind==="webhook"||candidate.kind==="work_run")||!candidate.config||typeof candidate.config!=="object"||Array.isArray(candidate.config)){
            setError("This automation has an unsupported action configuration and cannot be edited here.");return;
        }
        setError("");setEditingAutomation({id:item.id,version:item.version,name:item.name,triggerSet:triggerSet as Record<string,unknown>,action:{kind:candidate.kind,config:candidate.config as Record<string,unknown>}});
    }
    async function validateAutomationConfiguration(configuration:AutomationJobConfiguration){
        if(!editingAutomation)throw new Error("Choose an automation to edit first.");
        return api<AutomationJobValidation>(`automations/${encodeURIComponent(editingAutomation.id)}/configuration`,{method:"POST",body:JSON.stringify(configuration)});
    }
    async function saveAutomationConfiguration(configuration:AutomationJobConfiguration){
        if(!editingAutomation)throw new Error("Choose an automation to edit first.");
        const updated=await api<Record<string,unknown>>(`automations/${encodeURIComponent(editingAutomation.id)}/configuration`,{method:"PATCH",body:JSON.stringify({...configuration,expected_version:editingAutomation.version})});
        setItems(current=>current.map(row=>row.id===editingAutomation.id?{...row,...updated,trigger_set:configuration.trigger_set,action:configuration.action}:row));
        setEditingAutomation(null);
    }
    async function simulateAutomationEvent(jobId:string,request:{event_family:string;event_type:string;payload:Record<string,unknown>}){
        return api<AutomationSimulationResult>(`automations/${encodeURIComponent(jobId)}/simulate-event`,{method:"POST",body:JSON.stringify(request)});
    }
    async function archiveAutomation(item:Record<string,unknown>){
        if(typeof item.id!=="string"||item.archived===true||typeof item.version!=="number")return;
        if(!window.confirm("Archive this automation? It will stop future scheduled runs. Pending deliveries remain available for review."))return;
        setBusy(true);setError("");
        try{const updated=await api<Record<string,unknown>>(`automations/${encodeURIComponent(item.id)}/archive`,{method:"POST",body:JSON.stringify({expected_version:item.version})});setItems(current=>current.map(row=>row.id===item.id?{...row,...updated}:row));}
        catch(reason){setError(reason instanceof Error?reason.message:"This automation could not be archived");}
        finally{setBusy(false);}
    }
    async function restoreAutomation(item:Record<string,unknown>){
        if(typeof item.id!=="string"||item.archived!==true||typeof item.version!=="number")return;
        setBusy(true);setError("");
        try{const updated=await api<Record<string,unknown>>(`automations/${encodeURIComponent(item.id)}/restore`,{method:"POST",body:JSON.stringify({expected_version:item.version})});setItems(current=>current.map(row=>row.id===item.id?{...row,...updated}:row));setNotice("Automation restored in a paused state. Review it, then resume when ready.");}
        catch(reason){setError(reason instanceof Error?reason.message:"This automation could not be restored");}
        finally{setBusy(false);}
    }
    async function deleteAutomation(item:Record<string,unknown>){
        if(typeof item.id!=="string"||item.archived!==true||typeof item.version!=="number")return;
        if(window.prompt("Permanently delete this archived automation and its completed history? Type DELETE to confirm.")!=="DELETE")return;
        setBusy(true);setError("");
        try{await api<void>(`automations/${encodeURIComponent(item.id)}`,{method:"DELETE",body:JSON.stringify({confirmed:true,expected_version:item.version})});setItems(current=>current.filter(row=>row.id!==item.id));}
        catch(reason){setError(reason instanceof Error?reason.message:"This automation could not be deleted; it may have active or uncertain work");}
        finally{setBusy(false);}
    }
    async function runAutomationNow(item:Record<string,unknown>){
        if(typeof item.id!=="string"||item.enabled!==true)return;
        const key=`myso-automation-run:${item.id}`;
        let requestId:string;
        try{requestId=sessionStorage.getItem(key)??crypto.randomUUID();sessionStorage.setItem(key,requestId);}catch{requestId=crypto.randomUUID();}
        setBusy(true);setError("");setNotice("");
        try{
            const result=await api<{accepted:boolean;deduplicated:boolean;status:string}>(`automations/${encodeURIComponent(item.id)}/run-now`,{method:"POST",body:JSON.stringify({requestId})});
            try{sessionStorage.removeItem(key);}catch{}
            setNotice(result.accepted?"Automation run queued. Check its run history for the outcome.":"That run request was already queued or processed. Check its run history.");
        }catch(reason){setError(reason instanceof Error?reason.message:"This automation could not be queued. Retry to reuse the same request safely.");}
        finally{setBusy(false);}
    }
    async function loadAutomationRuns(item:Record<string,unknown>,offset=0,append=false){
        if(typeof item.id!=="string")return;
        const jobId=item.id;
        setAutomationRunJob(jobId);if(!append){setAutomationRuns([]);setAutomationRunNextOffset(null);}setAutomationRunLoading(true);setError("");
        try{const result=await api<{items:AutomationRun[];hasMore:boolean;nextOffset:number|null}>(`automations/${encodeURIComponent(jobId)}/runs?limit=50&offset=${offset}`);setAutomationRuns(current=>append?[...current,...result.items]:result.items);setAutomationRunNextOffset(result.nextOffset);}
        catch(reason){setError(reason instanceof Error?reason.message:"Run history is unavailable");if(!append)setAutomationRunJob(null);}
        finally{setAutomationRunLoading(false);}
    }
    async function reconcileOrphanAutomationRun(run:AutomationRun,resolution:"confirmed_succeeded"|"closed_uncertain_no_replay"){
        if(!automationRunJob)return;
        const note=automationRunReconcileNotes[run.id]?.trim()??"";
        if(note.length<8)return;
        const prompt=resolution==="confirmed_succeeded"
            ?"Confirm this run only if you verified that its work completed successfully. This does not replay it. Continue?"
            :"Close this stale run without replay. Its external outcome may remain uncertain, and no action will be retried. Continue?";
        if(!window.confirm(prompt))return;
        setAutomationRunResolving(run.id);setError("");
        try{
            const updated=await api<AutomationRun>(`automations/${encodeURIComponent(automationRunJob)}/runs/${encodeURIComponent(run.id)}/reconcile`,{method:"POST",body:JSON.stringify({jobId:automationRunJob,resolution,note,confirmed:true})});
            setAutomationRuns(current=>current.map(item=>item.id===run.id?updated:item));
            setAutomationRunReconcileNotes(current=>{const next={...current};delete next[run.id];return next;});
        }catch(reason){setError(reason instanceof Error?reason.message:"This run is not eligible for orphan reconciliation");}
        finally{setAutomationRunResolving(null);}
    }
    async function loadAutomationDeliveries(item:Record<string,unknown>,offset=0,append=false){
        if(typeof item.id!=="string")return;
        const jobId=item.id;
        if(!append&&automationDeliveryJob===jobId){setAutomationDeliveryJob(null);setAutomationDeliveries([]);setAutomationDeliveryNextOffset(null);return;}
        setAutomationDeliveryLoading(true);setAutomationDeliveryJob(jobId);if(!append){setAutomationDeliveries([]);setAutomationDeliveryNextOffset(null);setAutomationReconcileNotes({});}setError("");
        try{const result=await api<{items:AutomationDelivery[];hasMore:boolean;nextOffset:number|null}>(`automations/${encodeURIComponent(jobId)}/deliveries?limit=50&offset=${offset}`);setAutomationDeliveries(current=>append?[...current,...result.items]:result.items);setAutomationDeliveryNextOffset(result.nextOffset);}
        catch(reason){setError(reason instanceof Error?reason.message:"Delivery history is unavailable");if(!append){setAutomationDeliveries([]);setAutomationDeliveryJob(null);}}
        finally{setAutomationDeliveryLoading(false);}
    }
    async function loadAutomationDelegates(cursor?:string,append=false){
        setAutomationDelegateLoading(true);setError("");
        try{const query=new URLSearchParams({limit:"20",...(cursor?{cursor}:{})});const result=await api<{items:AutomationDelegate[];hasNextPage:boolean;nextCursor:string|null}>(`automations/delegates?${query}`);setAutomationDelegates(current=>append&&current?[...current,...result.items]:result.items);setAutomationDelegateHasNext(result.hasNextPage);setAutomationDelegateCursor(result.nextCursor);}
        catch(reason){setError(reason instanceof Error?reason.message:"Delegate authority is unavailable");setAutomationDelegates(null);}
        finally{setAutomationDelegateLoading(false);}
    }
    async function createAutomationJob(input:AutomationJobCreateInput,idempotencyKey:string){
        const created=await api<Record<string,unknown>>("automations",{method:"POST",body:JSON.stringify({...input,idempotencyKey})});
        setItems(current=>[{...created},...current.filter(item=>item.id!==created.id)]);
    }
    async function validateAutomationJob(input:AutomationJobCreateInput){
        return api<AutomationJobValidation>("automations/validate",{method:"POST",body:JSON.stringify(input)});
    }
    async function loadAutomationDelegateKeyEvents(cursor?:string,append=false){
        setAutomationDelegateKeyEventLoading(true);setError("");
        try{const query=new URLSearchParams({limit:"20",...(cursor?{cursor}:{})});const result=await api<{items:AutomationDelegateKeyEvent[];hasNextPage:boolean;nextCursor:string|null}>(`automations/delegates/events?${query}`);setAutomationDelegateKeyEvents(current=>append&&current?[...current,...result.items]:result.items);setAutomationDelegateKeyEventHasNext(result.hasNextPage);setAutomationDelegateKeyEventCursor(result.nextCursor);}
        catch(reason){setError(reason instanceof Error?reason.message:"Delegate key history is unavailable");setAutomationDelegateKeyEvents(null);}
        finally{setAutomationDelegateKeyEventLoading(false);}
    }
    async function reconcileAutomationDelivery(delivery:AutomationDelivery,resolution:"confirmed_succeeded"|"confirmed_not_executed_retry"){
        const note=automationReconcileNotes[delivery.id]?.trim()??"";
        if(!automationDeliveryJob||note.length<8)return;
        if(resolution==="confirmed_not_executed_retry"&&!window.confirm("Requeue this original event only if you have verified that its external action never executed. It may run again. Continue?"))return;
        setBusy(true);setError("");
        try{
            const result=await api<AutomationDelivery>(`automations/${encodeURIComponent(automationDeliveryJob)}/deliveries/${encodeURIComponent(delivery.id)}/reconcile`,{method:"POST",body:JSON.stringify({jobId:automationDeliveryJob,resolution,note,confirmed:true})});
            setAutomationDeliveries(current=>current.map(item=>item.id===delivery.id?result:item));setAutomationReconcileNotes(current=>{const next={...current};delete next[delivery.id];return next;});
        }catch(reason){setError(reason instanceof Error?reason.message:"This delivery could not be reconciled");}
        finally{setBusy(false);}
    }
    async function cancelAutomationDelivery(delivery:AutomationDelivery){
        const note=automationReconcileNotes[delivery.id]?.trim()??"";
        if(!automationDeliveryJob||note.length<8)return;
        if(!window.confirm("Cancel this delivery only if it should never run. Cancellation succeeds only before a worker claims it."))return;
        setBusy(true);setError("");
        try{
            const result=await api<AutomationDelivery>(`automations/deliveries/${encodeURIComponent(delivery.id)}/cancel`,{method:"POST",body:JSON.stringify({jobId:automationDeliveryJob,note,confirmed:true})});
            setAutomationDeliveries(current=>current.map(item=>item.id===delivery.id?result:item));setAutomationReconcileNotes(current=>{const next={...current};delete next[delivery.id];return next;});
        }catch(reason){setError(reason instanceof Error?reason.message:"This delivery could not be cancelled; it may already be claimed");}
        finally{setBusy(false);}
    }
    useEffect(()=>{setDeliveryCheck(null);},[view]);
    async function downloadTaskArtifact(item:Record<string,unknown>){
        const taskId=item.taskId;
        if(typeof taskId!=="string")return;
        setArtifactLoading(taskId);setError("");setDeliveryCheck(null);
        try{
            const artifact=await api<{uri:string;digestHex:string;contentBase64:string;contentLength:number;digestVerified:true}>(`tasks/${encodeURIComponent(taskId)}/deliverable`);
            const raw=atob(artifact.contentBase64);const bytes=new Uint8Array(raw.length);
            for(let index=0;index<raw.length;index++)bytes[index]=raw.charCodeAt(index);
            if(artifact.digestVerified!==true||bytes.byteLength!==artifact.contentLength)throw new Error("The downloaded artifact length or server digest check did not match its record");
            const expectedDigest=typeof item.contentDigest==="string"?item.contentDigest.toLowerCase():artifact.digestHex.toLowerCase();
            if(expectedDigest&&artifact.digestHex.toLowerCase()!==expectedDigest)throw new Error("The downloaded artifact digest did not match this work run");
            const actualDigest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),value=>value.toString(16).padStart(2,"0")).join("");
            if(actualDigest!==artifact.digestHex.toLowerCase())throw new Error("The downloaded artifact bytes failed local SHA-256 verification");
            const isTaskPackage=bytes.byteLength>=4&&bytes[0]===0x50&&bytes[1]===0x4b&&bytes[2]===0x03&&bytes[3]===0x04;
            // Bytes and digest are verified above; a manifest failure still lets the buyer save the raw bytes.
            if(!isTaskPackage){setDeliveryCheck({taskId,bytes,kind:"single"});return;}
            try{const files=await verifyTaskDeliveryPackage(bytes,artifact.digestHex);setDeliveryCheck({taskId,bytes,kind:"package",files});}
            catch(reason){setDeliveryCheck({taskId,bytes,kind:"package-failed",reason:reason instanceof Error?reason.message:"The package manifest could not be verified."});}
        }catch(reason){setError(reason instanceof Error?reason.message:"This task artifact could not be downloaded");}
        finally{setArtifactLoading(null);}
    }
    async function openTaskDetails(item:Record<string,unknown>){
        if(typeof item.taskId!=="string")return;
        const request=++taskDetailRequest.current;
        taskReceiptRequest.current++;setTaskSettlement(null);setTaskSettlementLoading(false);setTaskHistoryLoading(false);setCancelOfferReceipt(null);setCancelOfferReceiptLoading(false);setCancelOfferSubmission(null);const pendingCancelDigest=sessionStorage.getItem(`myso-agents:task-cancel-offer-digest:${item.taskId}`);if(pendingCancelDigest)setCancelOfferSubmission({taskId:item.taskId,digest:pendingCancelDigest});setDeliveryFiles([]);setDeliveryUploadAckKey("");setDeliveryUri("");setDeliveryDigest("");setDeliverySubmission(null);setDeliveryReceipt(null);setReviewSubmission(null);setReviewReceipt(null);setTaskLoading(true);setSelectedTask(null);setError("");
        try{const detail=await api<TaskDetail>(`tasks/${encodeURIComponent(item.taskId)}`);if(request===taskDetailRequest.current){setSelectedTask(detail);const role=taskReviewRole(detail,context);if(role){for(let stars=1;stars<=5;stars+=1){const opKey=`myso-agents:task-review:${detail.taskId}:${role}:${stars}`;const digest=sessionStorage.getItem(`${opKey}:digest`);if(digest){setReviewStars(stars);setReviewSubmission({submitted:true,transactionDigest:digest,taskId:detail.taskId,raterRole:role,stars});break;}if(sessionStorage.getItem(opKey))setReviewStars(stars);}}}}
        catch(reason){if(request===taskDetailRequest.current)setError(reason instanceof Error?reason.message:"Task details are unavailable to this account");}
        finally{if(request===taskDetailRequest.current)setTaskLoading(false);}
    }
    async function loadMoreTaskHistory(){
        const task=selectedTask;if(!task||task.nextHistoryOffset===null||taskHistoryLoading)return;
        const request=taskDetailRequest.current;setTaskHistoryLoading(true);setError("");
        try{
            const page=await api<TaskDetail>(`tasks/${encodeURIComponent(task.taskId)}?historyOffset=${task.nextHistoryOffset}&historyLimit=${task.historyLimit}`);
            if(request!==taskDetailRequest.current||!sameObjectId(page.taskId,task.taskId)||page.historyOffset!==task.nextHistoryOffset) return;
            setSelectedTask(current=>{
                if(!current||!sameObjectId(current.taskId,task.taskId))return current;
                const seen=new Set(current.history.map(event=>`${event.sourceEventId}:${event.eventType}`));
                return {...current,history:[...current.history,...page.history.filter(event=>!seen.has(`${event.sourceEventId}:${event.eventType}`))],nextHistoryOffset:page.nextHistoryOffset};
            });
        }catch(reason){setError(reason instanceof Error?reason.message:"More task history is unavailable");}
        finally{if(request===taskDetailRequest.current)setTaskHistoryLoading(false);}
    }
    async function verifyTaskSettlement(taskId:string){
        const request=++taskReceiptRequest.current;setTaskSettlementLoading(true);setTaskSettlement(null);setError("");
        try{const receipt=await api<TaskSettlementReceipt>(`tasks/${encodeURIComponent(taskId)}/settlement-receipt`);if(request===taskReceiptRequest.current)setTaskSettlement(receipt);}
        catch(reason){if(request===taskReceiptRequest.current)setError(reason instanceof Error?reason.message:"Task settlement could not be verified");}
        finally{if(request===taskReceiptRequest.current)setTaskSettlementLoading(false);}
    }
    async function acceptTaskOffer(item:Record<string,unknown>){
        const taskId=item.taskId;const termsDigestHex=item.termsDigest;
        if(typeof taskId!=="string"||typeof termsDigestHex!=="string"||!/^(0x)?[0-9a-fA-F]{1,64}$/.test(taskId)||!/^[0-9a-fA-F]{64}$/.test(termsDigestHex)||item.status!==0||!context||!sameObjectId(item.sellerAgentId,context.scope.agentId)||!tools.some(tool=>tool.name==="task_accept"))return;
        setAcceptingTask(taskId);setError("");setAcceptedSubmission(null);setAcceptReceipt(null);
        const key=`myso-agents:task-accept:${taskId}:${termsDigestHex}`;const idempotencyKey=sessionStorage.getItem(key)??crypto.randomUUID();sessionStorage.setItem(key,idempotencyKey);
        try{
            const result=await api<TaskAcceptResult>(`tasks/${encodeURIComponent(taskId)}/accept`,{method:"POST",body:JSON.stringify({termsDigestHex,idempotencyKey})});
            sessionStorage.removeItem(key);setAcceptedSubmission({taskId,digest:result.transactionDigest});await refresh();if(run?.taskId&&sameObjectId(run.taskId,taskId))void backfillTaskHistory(run.id);
        }catch(reason){setError(reason instanceof Error?reason.message:"The offer could not be accepted; retry only with the same pending operation");}
        finally{setAcceptingTask(null);}
    }
    async function verifyTaskAcceptance(submission:NonNullable<typeof acceptedSubmission>){
        setAcceptReceiptLoading(true);setAcceptReceipt(null);setError("");
        try{const query=new URLSearchParams({taskId:submission.taskId});const receipt=await api<TaskAcceptReceipt>(`task-accept-receipts/${encodeURIComponent(submission.digest)}?${query.toString()}`);if(receipt.digest!==submission.digest||!sameObjectId(receipt.taskId,submission.taskId)||receipt.status==="finalized"&&receipt.verification!=="finalized_task_accepted_event")throw new Error("Acceptance evidence did not match the submitted offer");setAcceptReceipt(receipt);}
        catch(reason){setError(reason instanceof Error?reason.message:"Task acceptance could not be verified yet");}
        finally{setAcceptReceiptLoading(false);}
    }
    async function submitTaskReview(task:TaskDetail){
        const raterRole=taskReviewRole(task,context);
        if(!raterRole||task.status!==3||task.reviewDeadlineMs===null||Date.now()>task.reviewDeadlineMs||!tools.some(tool=>tool.name==="task_review"))return;
        const roleCode=raterRole==="buyer"?1:2;
        if(task.reviews.some(review=>review.raterRole===roleCode))return;
        const key=`myso-agents:task-review:${task.taskId}:${raterRole}:${reviewStars}`;
        const idempotencyKey=sessionStorage.getItem(key)??crypto.randomUUID();sessionStorage.setItem(key,idempotencyKey);
        setBusy(true);setError("");setReviewSubmission(null);setReviewReceipt(null);
        try{
            const result=await api<TaskReviewResult>(`tasks/${encodeURIComponent(task.taskId)}/review`,{method:"POST",body:JSON.stringify({stars:reviewStars,idempotencyKey})});
            if(result.taskId!==task.taskId||result.raterRole!==raterRole||result.stars!==reviewStars)throw new Error("The review response did not match this task and rating");
            sessionStorage.setItem(`${key}:digest`,result.transactionDigest);
            setReviewSubmission(result);
        }catch(reason){setError(reason instanceof Error?reason.message:"The review could not be submitted; retry the same rating to reconcile the pending operation");}
        finally{setBusy(false);}
    }
    async function verifyTaskReview(submission:TaskReviewResult){
        setReviewReceiptLoading(true);setReviewReceipt(null);setError("");
        try{
            const query=new URLSearchParams({taskId:submission.taskId,raterRole:submission.raterRole,stars:String(submission.stars)});
            const receipt=await api<TaskReviewReceipt>(`task-review-receipts/${encodeURIComponent(submission.transactionDigest)}?${query.toString()}`);
            if(receipt.digest!==submission.transactionDigest||!sameObjectId(receipt.taskId,submission.taskId)||receipt.raterRole!==submission.raterRole||receipt.stars!==submission.stars||receipt.status==="finalized"&&receipt.verification!=="finalized_task_review_submitted_event")throw new Error("Review evidence did not match the submitted rating");
            setReviewReceipt(receipt);
            if(receipt.status==="finalized"){const key=`myso-agents:task-review:${submission.taskId}:${submission.raterRole}:${submission.stars}`;sessionStorage.removeItem(key);sessionStorage.removeItem(`${key}:digest`);}
        }catch(reason){setError(reason instanceof Error?reason.message:"The review receipt could not be verified yet");}
        finally{setReviewReceiptLoading(false);}
    }
    async function cancelTaskOffer(task:TaskDetail){
        if(task.status!==0||!context||!sameObjectId(task.buyerPrincipal,context.scope.owner)||!sameObjectId(task.buyerMemoryAccountId,context.scope.accountId)||task.buyerAgentId!==null&&!sameObjectId(task.buyerAgentId,context.scope.agentId)||!tools.some(tool=>tool.name==="task_cancel_offer"))return;
        if(!window.confirm("Cancel this open offer? The escrow will be returned to the buyer, and the seller will no longer be able to accept it."))return;
        setCancellingTask(task.taskId);setError("");setCancelOfferReceipt(null);
        const key=`myso-agents:task-cancel-offer:${task.taskId}`;const idempotencyKey=sessionStorage.getItem(key)??crypto.randomUUID();sessionStorage.setItem(key,idempotencyKey);
        try{
            const result=await api<TaskCancelOfferResult>(`tasks/${encodeURIComponent(task.taskId)}/cancel-offer`,{method:"POST",body:JSON.stringify({idempotencyKey})});
            if(result.taskId!==task.taskId)throw new Error("The cancellation response did not match the selected task");
            sessionStorage.setItem(`myso-agents:task-cancel-offer-digest:${task.taskId}`,result.transactionDigest);setCancelOfferSubmission({taskId:task.taskId,digest:result.transactionDigest});
        }catch(reason){setError(reason instanceof Error?reason.message:"Offer cancellation could not be submitted; retry only with the same pending operation");}
        finally{setCancellingTask(null);}
    }
    async function verifyTaskOfferCancellation(submission:NonNullable<typeof cancelOfferSubmission>){
        setCancelOfferReceiptLoading(true);setCancelOfferReceipt(null);setError("");
        try{
            const query=new URLSearchParams({taskId:submission.taskId});const receipt=await api<TaskCancelOfferReceipt>(`tasks/cancel-offer-receipts/${encodeURIComponent(submission.digest)}?${query}`);
            if(receipt.taskId!==submission.taskId||receipt.digest!==submission.digest)throw new Error("Finalized cancellation evidence did not match the submitted task");
            setCancelOfferReceipt(receipt);
            if(receipt.status==="finalized"){
                sessionStorage.removeItem(`myso-agents:task-cancel-offer:${submission.taskId}`);sessionStorage.removeItem(`myso-agents:task-cancel-offer-digest:${submission.taskId}`);
                const detail=await api<TaskDetail>(`tasks/${encodeURIComponent(submission.taskId)}`);setSelectedTask(detail);await refresh();
            }
        }catch(reason){setError(reason instanceof Error?reason.message:"Task cancellation receipt could not be verified");}
        finally{setCancelOfferReceiptLoading(false);}
    }
    async function bindTaskRoom(task:TaskDetail){
        if(!context||!task.roomGroupId||(task.status!==0&&task.status!==1)||!tools.some(tool=>tool.name==="messaging_bind_room_to_task"))return;
        const assignedBuyer=sameObjectId(task.buyerPrincipal,context.scope.owner)&&!!task.buyerAgentId&&sameObjectId(task.buyerAgentId,context.scope.agentId);
        const assignedSeller=sameObjectId(task.sellerPrincipal,context.scope.owner)&&sameObjectId(task.sellerAgentId,context.scope.agentId);
        if(!assignedBuyer&&!assignedSeller)return;
        setBindingTaskRoom(task.taskId);setRoomBindingSubmission(null);setError("");
        const key=`myso-agents:task-room-bind:${task.taskId}:${task.roomGroupId}`;const idempotencyKey=sessionStorage.getItem(key)??crypto.randomUUID();sessionStorage.setItem(key,idempotencyKey);
        try{const result=await api<TaskRoomBindResult>(`tasks/${encodeURIComponent(task.taskId)}/bind-room`,{method:"POST",body:JSON.stringify({idempotencyKey})});sessionStorage.removeItem(key);setRoomBindingSubmission(result);}
        catch(reason){setError(reason instanceof Error?reason.message:"The task room could not be linked; retry with the same pending operation");}
        finally{setBindingTaskRoom(null);}
    }
    async function deliverTask(task:TaskDetail){
        const uri=deliveryUri.trim();const digestHex=deliveryDigest.trim().toLowerCase();
        if(task.status!==1||!/^r2:\/\/0x[0-9a-f]{64}\/[0-9a-f]{64}$/i.test(uri)||!/^[0-9a-f]{64}$/.test(digestHex)||!sameObjectId(task.sellerPrincipal,context?.scope.owner)||!sameObjectId(task.sellerAgentId,context?.scope.agentId)||!tools.some(tool=>tool.name==="task_deliver"))return;
        setDeliveringTask(task.taskId);setError("");setDeliverySubmission(null);setDeliveryReceipt(null);
        const storageKey=`myso-agents:task-deliver:${task.taskId}:${digestHex}:${encodeURIComponent(uri)}`;const idempotencyKey=sessionStorage.getItem(storageKey)??crypto.randomUUID();sessionStorage.setItem(storageKey,idempotencyKey);
        try{const result=await api<TaskDeliverResult>(`tasks/${encodeURIComponent(task.taskId)}/deliver`,{method:"POST",body:JSON.stringify({digestHex,uri,idempotencyKey})});sessionStorage.removeItem(storageKey);setDeliverySubmission({taskId:task.taskId,digest:result.transactionDigest,uri,digestHex});await refresh();if(run?.taskId&&sameObjectId(run.taskId,task.taskId))void backfillTaskHistory(run.id);}
        catch(reason){setError(reason instanceof Error?reason.message:"Task delivery could not be submitted; retry with the same URI and digest to reconcile the existing operation");}
        finally{setDeliveringTask(null);}
    }
    async function uploadTaskArtifact(task:TaskDetail){
        const files=deliveryFiles;
        const acknowledgmentKey=taskDeliverySelectionKey(task.taskId,files);
        if(!files.length||deliveryUploadAckKey!==acknowledgmentKey||files.length>10||files.some(file=>file.size<1)||files.reduce((sum,file)=>sum+file.size,0)>480*1024||task.status!==1||!sameObjectId(task.sellerPrincipal,context?.scope.owner)||!sameObjectId(task.sellerAgentId,context?.scope.agentId)||!tools.some(tool=>tool.name==="task_upload_deliverable"))return;
        setUploadingTask(task.taskId);setError("");setDeliverySubmission(null);setDeliveryReceipt(null);
        try{
            const packaged=await buildTaskDeliveryPackage(files);
            const bytes=packaged.bytes;
            const digestHex=packaged.digestHex;
            let binary="";for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,Math.min(offset+0x8000,bytes.length)));
            const contentBase64=btoa(binary);
            const storageKey=`myso-agents:task-upload:${task.taskId}:${digestHex}`;const idempotencyKey=sessionStorage.getItem(storageKey)??crypto.randomUUID();sessionStorage.setItem(storageKey,idempotencyKey);
            const uploaded=await api<TaskUploadResult>(`tasks/${encodeURIComponent(task.taskId)}/upload`,{method:"POST",body:JSON.stringify({contentBase64,idempotencyKey,acknowledgeBuyerAccess:true})});
            if(uploaded.taskId!==task.taskId||uploaded.contentLength!==packaged.contentLength||uploaded.digestHex.toLowerCase()!==digestHex||uploaded.storage!=="cloudflare_r2")throw new Error("The storage response did not match the packaged task files");
            sessionStorage.removeItem(storageKey);setDeliveryUri(uploaded.uri);setDeliveryDigest(uploaded.digestHex);setDeliveryFiles([]);setDeliveryUploadAckKey("");
        }catch(reason){setError(reason instanceof Error?reason.message:"The artifact could not be uploaded; retry with the same file to reconcile the pending upload");}
        finally{setUploadingTask(null);}
    }
    async function verifyTaskDelivery(submission:NonNullable<typeof deliverySubmission>){
        setDeliveryReceiptLoading(true);setDeliveryReceipt(null);setError("");
        try{const query=new URLSearchParams({uri:submission.uri,digestHex:submission.digestHex});const receipt=await api<TaskDeliveryReceipt>(`task-receipts/${encodeURIComponent(submission.digest)}?${query.toString()}`);if(receipt.taskId!==submission.taskId||receipt.digest!==submission.digest||receipt.status==="finalized"&&(receipt.uri!==submission.uri||receipt.digestHex!==submission.digestHex))throw new Error("Finalized delivery evidence did not match the submitted task artifact");setDeliveryReceipt(receipt);}
        catch(reason){setError(reason instanceof Error?reason.message:"Task delivery receipt could not be verified");}
        finally{setDeliveryReceiptLoading(false);}
    }
    async function settleTask(task:TaskDetail){
        if(task.status!==2||!task.platformId||!task.sellerMemoryAccountId||!sameObjectId(task.buyerPrincipal,context?.scope.owner)||!sameObjectId(task.buyerAgentId,context?.scope.agentId)||!tools.some(tool=>tool.name==="task_settle"))return;
        setSettlingTask(task.taskId);setError("");setSettlementSubmission(null);
        const key=`myso-agents:task-settle:${task.taskId}`;const idempotencyKey=sessionStorage.getItem(key)??crypto.randomUUID();sessionStorage.setItem(key,idempotencyKey);
        try{
            const result=await api<TaskSettleResult>(`tasks/${encodeURIComponent(task.taskId)}/settle`,{method:"POST",body:JSON.stringify({idempotencyKey})});
            setSettlementSubmission({taskId:task.taskId,digest:result.transactionDigest});if(run?.taskId&&sameObjectId(run.taskId,task.taskId))void backfillTaskHistory(run.id);
        }catch(reason){setError(reason instanceof Error?reason.message:"Task settlement could not be submitted; retry only with the same pending operation");}
        finally{setSettlingTask(null);}
    }
    async function loadRoomHistory(room:Record<string,unknown>,cursor?:RoomHistoryPage["nextCursor"]){
        if(typeof room.groupUuid!=="string")return;
        const current=++roomHistoryRequest.current;setSelectedRoom(room);setRoomHistoryLoading(true);setError("");
        if(!cursor){setRoomHistory(null);setRoomReceipts(null);}
        const query=new URLSearchParams({limit:"20"});if(cursor)for(const [key,value] of Object.entries(cursor))query.set(key,String(value));
        try{
            const page=await api<RoomHistoryPage>(`rooms/${encodeURIComponent(room.groupUuid)}/history?${query}`);
            if(current===roomHistoryRequest.current)setRoomHistory(previous=>{
                if(!cursor||!previous)return page;
                const entries=cursor.beforeOrder!==undefined?[...page.entries,...previous.entries]:[...previous.entries,...page.entries];
                return {...page,entries,allContentVerified:entries.length>0&&entries.every(entry=>entry.status==="verified_content")};
            });
            if(!cursor&&current===roomHistoryRequest.current)void loadRoomReceipts(room.groupUuid);
        }catch(reason){if(current===roomHistoryRequest.current)setError(reason instanceof Error?reason.message:"Room history is unavailable");}
        finally{if(current===roomHistoryRequest.current)setRoomHistoryLoading(false);}
    }
    async function loadRoomReceipts(uuid:string){
        const current=++roomReceiptRequest.current;setRoomReceiptsLoading(true);
        try{const receipts=await api<RoomReceipts>(`rooms/${encodeURIComponent(uuid)}/receipts`);if(current===roomReceiptRequest.current)setRoomReceipts(receipts);}
        catch(reason){if(current===roomReceiptRequest.current){setRoomReceipts(null);setError(reason instanceof Error?reason.message:"Room receipts are unavailable");}}
        finally{if(current===roomReceiptRequest.current)setRoomReceiptsLoading(false);}
    }
    function visibleReadTarget():string|undefined{
        if(!roomHistory||!context)return undefined;
        const own=roomReceipts?.members.find(member=>sameObjectId(member.member,context.derivedAddress));
        let upto=own?.readUpto??"0";const ordered=[...roomHistory.entries].sort((a,b)=>compareDecimal(a.order,b.order));
        for(const entry of ordered){
            if(compareDecimal(entry.order,upto)<=0)continue;
            if(entry.order!==nextDecimal(upto)||entry.status!=="verified_content")break;
            upto=entry.order;
        }
        return compareDecimal(upto,own?.readUpto??"0")>0?upto:undefined;
    }
    async function markVisibleRoomRead(){
        if(typeof selectedRoom?.groupUuid!=="string"||!roomHistory||roomReceiptUpdating)return;
        const upto=visibleReadTarget();if(upto===undefined)return;
        setRoomReceiptUpdating(true);setError("");
        try{
            await api<RoomReceiptUpdateResult>(`rooms/${encodeURIComponent(selectedRoom.groupUuid)}/receipts`,{method:"POST",body:JSON.stringify({readUpto:upto})});
            await loadRoomReceipts(selectedRoom.groupUuid);
        }catch(reason){setError(reason instanceof Error?reason.message:"The room read receipt could not be updated");}
        finally{setRoomReceiptUpdating(false);}
    }
    function closeRoomHistory(){roomHistoryRequest.current++;roomReceiptRequest.current++;setSelectedRoom(null);setRoomHistory(null);setRoomReceipts(null);setRoomHistoryLoading(false);setRoomReceiptsLoading(false);}
    async function loadRoomMembers(groupId:string,cursor?:string){
        const current=++roomMembersRequest.current;setRoomMemberGroupId(groupId);setRoomMembersLoading(true);setError("");if(!cursor)setRoomMembers(null);
        const query=new URLSearchParams({limit:"50"});if(cursor)query.set("cursor",cursor);
        try{const page=await api<RoomMemberPage>(`rooms/${encodeURIComponent(groupId)}/members?${query}`);if(current===roomMembersRequest.current)setRoomMembers(previous=>!cursor||!previous? page:{...page,members:[...previous.members,...page.members]});}
        catch(reason){if(current===roomMembersRequest.current)setError(reason instanceof Error?reason.message:"Current room members are unavailable");}
        finally{if(current===roomMembersRequest.current)setRoomMembersLoading(false);}
    }
    async function inviteRoomMember(uuid:string,groupId:string){
        const member=roomInviteAddress.trim();
        if(!/^0x[0-9a-fA-F]{1,64}$/.test(member)||roomInviteAckGroupId!==groupId||!tools.some(tool=>tool.name==="messaging_add_room_members"))return;
        setRoomInvitingGroupId(groupId);setRoomInviteResult(null);setError("");
        try{
            const result=await api<RoomInviteResult>(`rooms/${encodeURIComponent(uuid)}/members`,{method:"POST",body:JSON.stringify({member,acknowledgeHistoryAccess:true})});
            if(!sameObjectId(result.groupId,groupId)||!sameObjectId(result.member,member)||result.historyAccess!=="past_and_future"||result.verification!=="finalized_reader_and_sender_permissions"&&result.verification!=="already_had_reader_and_sender_permissions")throw new Error("The finalized room invite did not match the selected room and wallet.");
            setRoomInviteResult(result);setRoomInviteAddress("");setRoomInviteAckGroupId(null);await loadRoomMembers(groupId);
        }catch(reason){setError(reason instanceof Error?reason.message:"The room member could not be invited");}
        finally{setRoomInvitingGroupId(null);}
    }
    async function renameRoom(uuid:string,groupId:string,name:string){
        setRoomRenamingGroupId(groupId);setError("");setNotice("");
        try{
            const result=await api<{updated:true;groupId:string;name:string;digest:string;verification:"fullnode_metadata_refetched";source:"myso_fullnode"}>(`rooms/${encodeURIComponent(uuid)}/name`,{method:"POST",body:JSON.stringify({name})});
            if(!result.updated||!sameObjectId(result.groupId,groupId)||result.name!==name.normalize("NFC")||result.verification!=="fullnode_metadata_refetched"||result.source!=="myso_fullnode")throw new Error("The confirmed room metadata did not match the requested change.");
            setItems(current=>current.map(item=>sameObjectId(String(item.groupId??""),groupId)?{...item,groupName:result.name}:item));
            setSelectedRoom(current=>current&&sameObjectId(String(current.groupId??""),groupId)?{...current,groupName:result.name}:current);
            setNotice(`Room name updated and re-read from MySo. Transaction ${result.digest}.`);
        }catch(reason){setError(reason instanceof Error?reason.message:"Room name could not be updated");}
        finally{setRoomRenamingGroupId(null);}
    }
    async function archiveRoom(uuid:string,groupId:string){
        if(!context||!ownerWalletMatches||!walletAccount||!tools.some(tool=>tool.name==="messaging_archive_group")||roomArchivingGroupId!==null)return;
        const confirmed=window.confirm("Permanently archive this encrypted room? This pauses the room and permanently removes its unpause capability. The action cannot be reversed.");
        if(!confirmed)return;
        setRoomArchivingGroupId(groupId);setError("");setNotice("");
        try{
            const owner=normalizeKeyAddress(context.scope.owner);const agentObjectId=normalizeKeyAddress(context.scope.agentId);const canonicalGroupId=normalizeKeyAddress(groupId);const expiresAtMs=Date.now()+2*60_000;const nonce=crypto.randomUUID();
            const message=`MySo Agents room archive\nOwner: ${owner}\nAgent: ${agentObjectId}\nGroup: ${canonicalGroupId}\nExpires: ${expiresAtMs}\nNonce: ${nonce}`;
            const signed=await signMessageRef.current({message:new TextEncoder().encode(message),chain:`myso:${context.scope.network}`});
            const result=await api<{archived:true;groupId:string;digest:string;verification:"finalized_archive_transaction";source:"myso_fullnode"}>(`rooms/${encodeURIComponent(uuid)}/archive`,{method:"POST",body:JSON.stringify({ownerConfirmation:{owner,agentObjectId,groupId:canonicalGroupId,expiresAtMs,nonce,signature:signed.signature}})});
            if(!result.archived||!sameObjectId(result.groupId,groupId)||result.verification!=="finalized_archive_transaction"||result.source!=="myso_fullnode")throw new Error("The finalized archive receipt did not match the selected room.");
            setItems(current=>current.map(item=>sameObjectId(String(item.groupId??""),groupId)?{...item,archived:true}:item));
            setSelectedRoom(current=>current&&sameObjectId(String(current.groupId??""),groupId)?{...current,archived:true}:current);
            setNotice(`Room permanently archived on MySo. Transaction ${result.digest}.`);
        }catch(reason){setError(reason instanceof Error?reason.message:"Room could not be archived");}
        finally{setRoomArchivingGroupId(null);}
    }
    async function removeRoomMember(){
        const target=roomRemovalTarget;
        if(!target||!roomRemovalAcknowledged||!tools.some(tool=>tool.name==="messaging_remove_members_rotate_key")||sameObjectId(target.member,context?.derivedAddress))return;
        setRoomRemovingGroupId(target.groupId);setRoomRemovalResult(null);setError("");
        try{
            const result=await api<RoomRemovalResult>(`rooms/${encodeURIComponent(target.uuid)}/members`,{method:"POST",body:JSON.stringify({action:"remove",member:target.member,acknowledgeFutureAccessRemoval:true})});
            if(!sameObjectId(result.groupId,target.groupId)||!sameObjectId(result.member,target.member)||result.futureAccess!=="revoked"||result.pastAccess!=="may_remain_available_or_previously_copied"||result.verification!=="finalized_membership_and_key_version"||BigInt(result.keyVersionAfter)<=BigInt(result.keyVersionBefore))throw new Error("The finalized room removal or key rotation did not match the selected member.");
            if(typeof selectedRoom?.groupId==="string"&&sameObjectId(selectedRoom.groupId,target.groupId)){closeRoomHistory();setRoomViewKey(value=>value+1);}
            setRoomRemovalResult(result);setRoomRemovalTarget(null);setRoomRemovalAcknowledged(false);await loadRoomMembers(target.groupId);
        }catch(reason){setError(reason instanceof Error?reason.message:"The room member could not be removed");}
        finally{setRoomRemovingGroupId(null);}
    }
    async function create(event:FormEvent){event.preventDefault();await createRun(goal,criterion);}
    async function createRun(goalText:string,criterionText:string):Promise<boolean>{
        if(!goalText.trim()||!criterionText.trim())return false;setBusy(true);setError("");
        const plan={version:1,goal:goalText.trim(),steps:pendingTaskId&&pendingTaskRole==="seller"?namedSellerSellerSteps(criterionText.trim()):pendingTaskId&&pendingTaskRole==="buyer"?namedSellerBuyerSteps(pendingTaskOffered):[{id:"deliver",title:goalText.trim().slice(0,200),dependsOn:[],acceptanceCriteria:[criterionText.trim()]}]};
        // Reuse create identity after an uncertain response, rather than invent another work item.
        if(!pendingCreate.current)pendingCreate.current={id:crypto.randomUUID(),plan,...(pendingTaskId?{taskId:pendingTaskId}:{})};
        else if(JSON.stringify(pendingCreate.current.plan)!==JSON.stringify(plan)||pendingCreate.current.taskId!==pendingTaskId){setError("Refresh your work list before changing an unconfirmed work request.");setBusy(false);return false;}
        try{const value=await workApi<WorkRun>("runs",{method:"POST",body:JSON.stringify(pendingCreate.current)});pendingCreate.current=null;runSelectionEpoch.current++;setRun(value);setCreating(false);if(runSelectionKey)sessionStorage.setItem(runSelectionKey,value.id);setGoal("");setCriterion("");setPendingTaskId(undefined);setPendingTaskRole(undefined);setPendingTaskOffered(false);await refresh();return true;}
        catch(reason){setError((reason as Error).message);return false;}finally{setBusy(false);}
    }
    function openView(name:View){if(busy)return;closeRoomHistory();taskDetailRequest.current++;taskReceiptRequest.current++;setTaskLoading(false);setTaskSettlement(null);setTaskSettlementLoading(false);setSelectedTask(null);setView(name);setOffset(0);setRun(null);setCreating(false);if(name==="automations"){void loadAutomationDelegates();void loadAutomationDelegateKeyEvents();}}
    function canAcceptOffer(item:Record<string,unknown>){return item.status===0&&!!context&&sameObjectId(item.sellerAgentId,context.scope.agentId)&&tools.some(tool=>tool.name==="task_accept");}
    async function send(event:FormEvent){
        event.preventDefault();if(!run||!input.trim()||!modelId)return;
        const allowRoomHistory=roomHistoryConsentRunId===run.id;
        const allowPrivateGraph=privateGraphConsentRunId===run.id;
        const allowPrivateTaskArtifacts=privateTaskArtifactConsentRunId===run.id;
        const allowPrivateContentSharing=privateContentShareConsentRunId===run.id&&(allowRoomHistory||allowPrivateGraph||allowPrivateTaskArtifacts);
        const model=models.find(item=>item.id===modelId);if(!model?.max_output_tokens)return;
        setBusy(true);setError("");
        const requestKey=`myso-agents:pending-turn:${run.id}`;
        const requestId=sessionStorage.getItem(requestKey)??crypto.randomUUID();sessionStorage.setItem(requestKey,requestId);
        const privateContentConsent=allowRoomHistory||allowPrivateGraph||allowPrivateTaskArtifacts;
        const allowedTools=tools.filter(tool=>!isHostedWorkToolForbidden(tool.name)&&(!HOSTED_WORK_ROOM_CONTENT_TOOLS.has(tool.name)||allowRoomHistory)&&(!HOSTED_WORK_PRIVATE_GRAPH_TOOLS.has(tool.name)||allowPrivateGraph)&&(!HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS.has(tool.name)||allowPrivateTaskArtifacts)&&(!privateContentConsent||allowPrivateContentSharing||!HOSTED_WORK_PRIVATE_CONTENT_OUTPUT_TOOLS.has(tool.name))&&(tool.readOnly&&/^(subscription_|payments_)/.test(tool.name)||/^(task_|jury_|messaging_|memory_|mydata_|access_purchase_mydata_access$|chain_get_action_status$|account_configure_multisig$|account_list_audit_logs$|agent_admin_(list|get_quote|get_receipt)$|agent_(get|list)|ai_(get|list)|room_list$|organization_(list_owned|get|get_statistics|list_roles|list_role_assignments|list_invitations|list_memory_permissions|list_spend_approvals|list_spend_breakdown|list_audit_logs)$|organization_list_rooms$|organization_list_messaging_groups$)/.test(tool.name))).map(tool=>tool.name);
        try{
            const result=await workApi<{run?:WorkRun;status?:string;replayed?:boolean}>(`runs/${run.id}/turn`,{method:"POST",body:JSON.stringify({requestId,input:input.trim(),modelId,maxModelTurns:10,maxOutputTokens:Math.min(model.max_output_tokens,4096),allowedTools,allowRoomHistory,allowPrivateGraph,allowPrivateTaskArtifacts,allowPrivateContentSharing})});
            setRun(result.run??await workApi<WorkRun>(`runs/${run.id}`));sessionStorage.removeItem(requestKey);setInput("");await refresh();
        }catch(reason){setError(`${(reason as Error).message}. Your request reference is saved; do not start another payment to resolve an unknown outcome.`);}
        finally{setBusy(false);}
    }
    const count=view==="work"?runs.length:items.length;
    return <div className="myso-workspace" data-sidebar={sidebar} data-sidebar-animated={sidebarAnimated?"":undefined} data-mobile-nav={mobileNav?"open":undefined}>
        {loginPhase&&<LoginStatusOverlay phase={loginPhase}/>}
        <header className="myso-header">
            <div className="myso-header-start"><button type="button" className="myso-icon-button myso-nav-menu" aria-label="Open navigation" aria-expanded={mobileNav} onClick={()=>setMobileNav(true)}><Menu size={18}/></button><a href="/" className="myso-brand" aria-label="MySo Agents"><img src="/brand/myso.svg" alt="" width="30" height="30"/><span>MySo <strong>Agents</strong></span></a><button type="button" className="myso-icon-button myso-nav-toggle" aria-label={sidebar==="expanded"?"Collapse sidebar":"Expand sidebar"} aria-expanded={sidebar==="expanded"} title="Toggle sidebar (⌘O / Ctrl+O)" onClick={toggleSidebar}><PanelLeft size={18}/></button></div>
            <div className="myso-account">{!account&&<span>Your work, coordinated</span>}
                {pendingApprovals>0&&<button type="button" className="myso-waiting" onClick={()=>openView("agents")} disabled={busy}><span className="myso-waiting-dot" aria-hidden="true"/>{pendingApprovals} waiting on you</button>}
                <button className="myso-icon-button" aria-label="Switch color theme" onClick={()=>setTheme(resolvedTheme==="dark"?"light":"dark")}><Sun size={18} className="hidden dark:block"/><Moon size={18} className="dark:hidden"/></button>
                {account?<AccountMenu owner={account.owner} label={account.label} busy={busy} onLogout={()=>{setCustodyAccessToken(null);setAccount(null);void (window.mysoAgents?.myso?.logout?.()??Promise.resolve()).then(()=>api("auth/logout",{method:"POST"})).then(()=>location.reload()).catch(reason=>setError(reason.message));}}/>:!connecting&&!desktopAuth&&<GetStartedButton pending={loginPending} onClick={()=>void connectHosted()}/>}
            </div>
        </header>
        <div className="myso-body">
            {mobileNav&&<div className="myso-rail-backdrop" aria-hidden="true" onClick={()=>setMobileNav(false)}/>}
            <nav className="myso-rail" aria-label="Workspace">
                {navGroups.map(([group,entries])=><div key={group} className="myso-rail-group" role="group" aria-label={group}><span className="myso-rail-heading" aria-hidden="true">{group}</span>{entries.map(([name,Icon])=><button key={name} aria-label={labels[name]} aria-current={view===name?"page":undefined} onClick={()=>{setMobileNav(false);openView(name);}} disabled={busy}><Icon size={20}/><span className="myso-rail-label" aria-hidden="true">{labels[name]}</span><ChevronRight size={14} className="myso-rail-chevron" aria-hidden="true"/><span className="myso-rail-tip" aria-hidden="true">{labels[name]}</span></button>)}</div>)}
            </nav>
            <main className="myso-main" data-view={view} key={run?`run-${run.id}`:view} aria-busy={busy||loading}>
                {!(view==="work"&&!run&&!creating&&context)&&<div className="myso-page-heading"><div><p className="myso-eyebrow">Your workspace</p><h1>{run?run.plan.goal:labels[view]}</h1></div><div className="myso-toolbar">{view==="work"&&workVault&&<button className="myso-secondary" disabled={vaultBusy||busy} onClick={()=>{if(workVault.status==="ready"){workVault.lock();setRuns([]);setTools(current=>current.filter(tool=>!tool.name.startsWith("work_run_")));}else void unlockWorkCustody();}}>{vaultBusy?"Unlocking…":workVault.status==="ready"?"Lock local custody":"Unlock encrypted work"}</button>}<button className="myso-icon-button" aria-label="Refresh current view" disabled={busy||loading||view==="knowledge"||view==="agents"} onClick={()=>void(run?selectRun(run.id):refresh())}><RefreshCw size={18}/></button>{view==="work"&&!run&&<button className="myso-primary" title="New work (⌘N / Ctrl+N)" disabled={!workVault||workVault.status!=="ready"} onClick={()=>setCreating(true)}><Plus size={17}/>New work</button>}</div></div>}
                {view==="jury"&&context&&<MySoJuryDuties agentId={context.derivedAddress} enabled={name=>tools.some(tool=>tool.name===name)}/>}
                {view==="work"&&workVault&&workVault.status!=="ready"&&!ownerWalletMatches&&<div className="myso-toolbar" role="group" aria-label="Connect the owner wallet to unlock work storage">{walletAccount&&<p className="myso-knowledge-note">The connected wallet does not match this agent’s owner. Connect the owner wallet to unlock encrypted work.</p>}{wallets.map(wallet=><button key={wallet.name} type="button" className="myso-secondary" disabled={walletConnect.isPending||busy} onClick={()=>void walletConnect.mutateAsync({wallet,accountAddress:context!.scope.owner}).catch(reason=>setError(reason instanceof Error?reason.message:"Owner wallet connection failed"))}><Wallet size={16}/>{walletConnect.isPending?"Connecting…":`Connect ${wallet.name}`}</button>)}</div>}
                {error&&<p role="alert" className="myso-error">{error}</p>}{notice&&<p role="status" className="myso-knowledge-note">{notice}</p>}
                {run?<>
                    <button className="myso-text-button" disabled={busy} onClick={()=>setRun(null)}><ArrowLeft size={16}/>All work</button>
                    <div className="myso-run-layout"><section aria-label="Work conversation">
                        {run.taskId&&<div className="myso-task-link"><p className="myso-eyebrow">TASK MARKETPLACE</p><strong>{run.marketplaceTask?.status===0?"Open-offer coordination":"Task coordination"} {run.taskId}</strong>{run.taskRole&&<span> · {run.taskRole} agent</span>}{run.marketplaceTask&&<p>Indexed task status: {["Offered","Accepted","Delivered","Settled","Refunded","Cancelled","Disputed"][run.marketplaceTask.status]??"Unknown"} · transaction {run.marketplaceTask.transactionId}</p>}{run.verifiedTaskState&&<p>Last finalized transition shown: {["Offered","Accepted","Delivered","Settled","Refunded","Cancelled","Disputed"][run.verifiedTaskState.status]??"Unknown"} · {run.verifiedTaskState.eventType.split("::").slice(-2).join("::")} · transaction {run.verifiedTaskState.transactionDigest}</p>}<p>{run.roomId?`Linked room ${run.roomId}`:"No task room is linked to this run."}</p><small>The indexed status is a participant-scoped preview. The run keeps a growing, encrypted history from service-checked pages; task details remain available for the current full participant history.</small><button type="button" className="myso-text-button" disabled={busy||taskLoading} onClick={()=>{setRun(null);setView("tasks");void openTaskDetails({taskId:run.taskId});}}>{taskLoading?"Opening task…":"Open task state and lifecycle"}<ArrowRight size={15}/></button></div>}
                        <div className="myso-status"><span className={`myso-dot ${run.status==="reconciling"?"myso-dot-warning":""}`}/>{status(run.status)}{run.cancelRequestedAt&&<span> · cancellation requested {date(run.cancelRequestedAt)}</span>}</div>
                        <button type="button" className="myso-text-button" disabled={runAiUsageLoading} onClick={()=>void loadRunAiUsage()}>{runAiUsageLoading?"Checking AI reservations…":"View AI spend by work step"}<ArrowRight size={15}/></button>
                        {runAiUsage?.runId===run.id&&<><section className="myso-run-receipts" aria-label="AI spend by work step"><p className="myso-eyebrow">AI SPEND BY STEP</p><p>{(runAiUsage.steps.reduce((sum,step)=>sum+BigInt(step.spentMist),0n)+BigInt(runAiUsage.coordination.spentMist)).toString()} MIST charged. AI permissions and available balance are checked by the live MySo AI-credit service.</p><ol>{runAiUsage.steps.map(step=><li key={step.stepId}><strong>{step.title}</strong><span>{step.spentMist} MIST charged · {step.operations} AI operation{step.operations===1?"":"s"}</span>{step.unresolved>0&&<small>{step.unresolved} unresolved operation{step.unresolved===1?"":"s"} · reconcile before retrying</small>}</li>)}</ol>{runAiUsage.coordination.unresolved>0&&<p className="myso-plan-note">Coordination has {runAiUsage.coordination.unresolved} unresolved AI operation{runAiUsage.coordination.unresolved===1?"":"s"}.</p>}</section><section className="myso-run-receipts" aria-label="MYSO action ledger by work step"><p className="myso-eyebrow">MYSO ACTION HISTORY</p><p>{runAiUsage.actionSteps.reduce((sum,step)=>sum+BigInt(step.spentMist),0n).toString()} MIST in completed journaled actions · {runAiUsage.actionSteps.reduce((sum,step)=>sum+BigInt(step.reservedMist),0n).toString()} MIST unresolved or reserved.</p><ol>{runAiUsage.actionSteps.map(step=><li key={step.stepId}><strong>{step.title}</strong><span>{step.spentMist} MIST recorded</span>{BigInt(step.reservedMist)>0n&&<small>{step.reservedMist} MIST unresolved or reserved · {step.operations} MYSO action{step.operations===1?"":"s"}</small>}</li>)}</ol><p className="myso-plan-note">These are journal and receipt amounts, not permissions or spend limits. Every action is authorized against the agent’s live on-chain capabilities and MYSO spend limit.</p></section></>}
                        <button type="button" className="myso-text-button" disabled={runOperationJournalLoading} onClick={()=>void loadRunOperationJournal()}>{runOperationJournalLoading?"Checking operation journal…":"Review pending action outcomes"}<ArrowRight size={15}/></button>
                        {runOperationJournal?.runId===run.id&&<section className="myso-run-receipts" aria-label="Pending action outcomes"><p className="myso-eyebrow">ACTION RECOVERY JOURNAL · {runOperationJournal.operations.length} unresolved</p>{runOperationJournal.operations.length===0?<p>No pending or reconciling operations are recorded in this run.</p>:<><p>These owner-scoped records stay held until the server matches the encrypted original input to its registered chain action or participant upload ledger, then verifies the terminal fullnode receipt or actual R2 bytes. Recovery never repeats the side effect.</p><ol>{runOperationJournal.operations.map(operation=>{const evidence=runOperationReceipts[operation.id];return <li key={operation.id}><strong>{operation.toolName.replaceAll("_"," ")} · {operation.status}</strong><span>Operation {operation.id} · call {operation.toolCallId}</span><small>Idempotency key: {operation.idempotencyKey}</small><small>Input hash: {operation.inputHash}</small>{operation.stepId&&<small>Plan step: {operation.stepId}</small>}{operation.maxAmountMist&&<small>Exact amount recorded in journal: {operation.maxAmountMist} MIST</small>}{operation.error&&<small>{operation.error}</small>}<button type="button" className="myso-text-button" disabled={runOperationReceiptLoading!==null} onClick={()=>void verifyRunOperationReceipt(operation.id)}>{runOperationReceiptLoading===operation.id?"Verifying stored outcome…":evidence?"Refresh verified outcome":operation.toolName==="task_upload_deliverable"?"Verify saved R2 upload":"Verify registered action receipt"}<ArrowRight size={15}/></button>{evidence?.retry&&<label className="myso-text-button">Retry exact saved upload<input type="file" accept="*/*" disabled={runOperationReceiptLoading!==null} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value="";if(file)void retryRunOperationUpload(operation.id,file);}}/><small>Choose the original file matching SHA-256 {evidence.retry.digestHex}; a different file is rejected.</small></label>}{evidence&&<div className="myso-plan-note" role="status">{evidence.recoveredUpload?<>R2 upload verified for task {evidence.recoveredUpload.taskId} · {evidence.recoveredUpload.contentLength} bytes · {evidence.recoveredUpload.digestHex}</>:evidence.chainAction?<>Registered action {evidence.chainAction.registryAction} · {evidence.chainAction.status}{evidence.chainAction.digest?` · ${evidence.chainAction.digest}`:""}</>:<>Operation still held: {evidence.verification}</>}{evidence.receipt&&<><small>Fullnode status: {evidence.receipt.status} · verification source: {evidence.verification}</small>{evidence.receipt.eventTypes.map((eventType,index)=><small key={`${eventType}-${index}`}>{eventType.split("::").slice(-2).join("::")}</small>)}</>}</div>}</li>;})}</ol></>}</section>}
                        {run.cancelRequestedAt&&<p role="status" className="myso-knowledge-note">The worker has been asked to stop. An operation that was already dispatched may still finish; any uncertain result stays in reconciliation.</p>}
                        {!run.cancelRequestedAt&&run.status!=="completed"&&["planned","running","yielded","waiting_for_input","waiting_for_approval","reconciling"].includes(run.status)&&<button type="button" className="myso-secondary" disabled={cancelingRun===run.id} onClick={()=>void cancelCurrentRun()}>{cancelingRun===run.id?"Requesting stop…":"Stop this work run"}</button>}
                        {run.status==="completed"&&<p className="myso-knowledge-note" role="status">Work run completed{run.completedAt?` · ${date(run.completedAt)}`:""}. Task delivery and escrow settlement remain separate.</p>}
                        {["planned","running","yielded","waiting_for_input","waiting_for_approval"].includes(run.status)&&run.plan.steps.length>0&&run.plan.steps.every(step=>run.stepStatus[step.id]==="succeeded")&&<button type="button" className="myso-primary" disabled={completingRun===run.id||!!run.cancelRequestedAt} onClick={()=>void completeCurrentRun()}>{completingRun===run.id?"Verifying completion…":"Complete work run"}</button>}
                        {run.receipts.length>0&&<section className="myso-run-receipts" aria-label="Verified work receipts"><p className="myso-eyebrow">WORK RECEIPTS</p><ol>{run.receipts.map(receipt=><li key={receipt.id}><strong>{receipt.kind.replaceAll("_"," ")}</strong><span>{receipt.verification.replaceAll("_"," ")}</span><code title={receipt.digest}>{receipt.digest.slice(0,10)}…{receipt.digest.slice(-6)}</code>{receipt.taskId&&<small>Task {receipt.taskId}</small>}{receipt.gasCostMist&&<small>Network gas charge {receipt.gasCostMist} MIST</small>}{receipt.gasRefundMist&&receipt.gasRefundMist!=="0"&&<small>Storage rebate {receipt.gasRefundMist} MIST</small>}{receipt.artifactDigest&&<small>Artifact SHA-256 {receipt.artifactDigest}</small>}{receipt.sourceEvidenceIds?.map(id=><small key={id}>Finalized task event evidence {id}</small>)}{receipt.eventEvidence?.map(item=><small key={item.sourceEventId}>{item.eventType.split("::").slice(-2).join("::")} · finalized event {item.sourceEventId}</small>)}<small>{date(receipt.recordedAt)}</small></li>)}</ol><p className="myso-plan-note">A receipt is verified only after the configured chain reader confirms its finalized transaction and matching task event.</p></section>}
                        {run.taskId&&<section className="myso-run-receipts" aria-label="Task lifecycle history"><div className="myso-market-sellers-heading"><div><p className="myso-eyebrow">TASK LIFECYCLE HISTORY</p><p>Participant-scoped task events checked against the configured fullnode are retained in this encrypted run journal.</p></div><button type="button" className="myso-secondary" disabled={runTaskHistoryRefreshing||run.taskHistory?.truncated===true||run.taskHistory?.evidenceSource==="participant_indexed_history_with_fullnode_event_checks"&&run.taskHistory.nextOffset===null} onClick={()=>void refreshRunTaskHistory()}>{runTaskHistoryRefreshing?"Checking next page…":run.taskHistory?.evidenceSource==="task_history_unavailable"?"Retry history capture":run.taskHistory?.events.length?"Load next history page":"Refresh task history"}</button></div>{!run.taskHistory||run.taskHistory.evidenceSource==="task_history_unavailable"?<p>The participant history is not yet available in this run. Refresh to retry the scoped history read.</p>:<><p>Saved {run.taskHistory.events.length} event{run.taskHistory.events.length===1?"":"s"}. Rows without matching fullnode evidence remain labeled as previews or unavailable.</p>{run.taskHistory.events.length===0?<p>No lifecycle transitions are indexed yet.</p>:<ol>{run.taskHistory.events.slice(-100).map(event=><li key={`${event.sourceEventId}:${event.eventType}`}><strong>{event.eventType.replaceAll("_"," ").replaceAll("."," · ")}</strong><span>{date(event.occurredAtMs)}</span><small>{event.verification.replaceAll("_"," ")}{event.status!==null?` · indexed status ${event.status}`:""}</small>{event.digest&&<code title={event.digest}>{event.digest}</code>}</li>)}</ol>}{run.taskHistory.events.length>100&&<p className="myso-plan-note">Showing the latest 100 saved events. Refresh pages to continue history capture.</p>}{run.taskHistory.truncated&&<p className="myso-plan-note">The journal reached its 10,000-event limit before the indexed history ended.</p>}</>}</section>}{run.taskLifecycleEvents&&run.taskLifecycleEvents.length>0&&<section className="myso-run-receipts" aria-label="Task lifecycle evidence"><p className="myso-eyebrow">TASK LIFECYCLE EVIDENCE</p><ol>{run.taskLifecycleEvents.map(event=><li key={event.operationId}><strong>{event.action.replaceAll("."," · ")}</strong><span>{event.verification.replaceAll("_"," ")}</span>{event.eventTypes.map(type=><small key={type}>{type.split("::").slice(-2).join("::")}</small>)}{event.sourceEvidenceIds?.map(id=><small key={id}>Finalized task event evidence {id}</small>)}{event.eventEvidence?.map(item=><small key={item.sourceEventId}>{item.eventType.split("::").slice(-2).join("::")} · finalized event {item.sourceEventId}</small>)}<code title={event.digest}>{event.digest.slice(0,10)}…{event.digest.slice(-6)}</code><small>{date(event.recordedAt)}</small></li>)}</ol><p className="myso-plan-note">These transitions are retained from the task actions journaled by this run and verified against the configured fullnode. Dispute and appeal receipts also link the paired jury event. The task detail remains the source for complete lifecycle history.</p></section>}
                        {run.artifacts.length>0&&<section className="myso-run-receipts" aria-label="Task artifacts"><p className="myso-eyebrow">TASK ARTIFACTS</p><ol>{run.artifacts.map(artifact=><li key={artifact.id}><strong>{artifact.mediaType} · {(artifact.contentLength/1024).toFixed(1)} KiB</strong><span>{artifact.verification.replaceAll("_"," ")}</span><code title={artifact.contentDigest}>{artifact.contentDigest.slice(0,16)}…{artifact.contentDigest.slice(-8)}</code><small>{artifact.taskId?`Task ${artifact.taskId}`:"Task artifact"}</small>{artifact.transactionDigest&&<small>Delivery transaction {artifact.transactionDigest}</small>}{artifact.sourceEvidenceIds.map(id=><small key={id}>Finalized task event evidence {id}</small>)}{artifact.verification==="verified"&&artifact.taskId&&<button type="button" className="myso-text-button" disabled={artifactLoading===artifact.taskId} onClick={()=>void downloadTaskArtifact({taskId:artifact.taskId,contentDigest:artifact.contentDigest})}>{artifactLoading===artifact.taskId?"Verifying delivery…":"Verify delivery"}<ArrowRight size={15}/></button>}{deliveryCheck&&deliveryCheck.taskId===artifact.taskId&&<MySoDeliveryManifest check={deliveryCheck} onClose={()=>setDeliveryCheck(null)}/>}</li>)}</ol><p className="myso-plan-note">A pending artifact becomes verified only when a finalized TaskDelivered event matches its exact URI and content digest. Downloads verify the server record and the bytes locally.</p></section>}
                        {readableMessages(run).map(message=><article className={`myso-message myso-message-${message.role}`} key={message.key}><h3>{message.role==="user"?"You":"Agent"}</h3><p>{message.text}</p></article>)}
                        {!readableMessages(run).length&&<div className="myso-empty-inline"><h2>Ready when you are</h2><p>Give your agent the context it needs. It can clarify the requirements and propose a work plan.</p></div>}
                        <form className="myso-composer" onSubmit={send}><label htmlFor="work-input">Message your agent</label><textarea id="work-input" value={input} onChange={event=>setInput(event.target.value)} maxLength={10000} rows={4} disabled={busy||run.status==="reconciling"} placeholder="Describe what you need, or answer your agent’s question…"/>
                            {tools.some(tool=>HOSTED_WORK_ROOM_CONTENT_TOOLS.has(tool.name))&&<label className="myso-room-ai-consent"><input type="checkbox" checked={roomHistoryConsentRunId===run.id} disabled={busy||run.status==="reconciling"} onChange={event=>setRoomHistoryConsentRunId(event.target.checked?run.id:null)}/><span><strong>Allow this work run to use authorized room messages and attachments</strong><small>Verified message text and any specifically selected, signature-verified attachment plaintext may be sent to the selected hosted model for this turn. It is removed from the durable run transcript before checkpointing, and cleared before a resumed turn. Room access is checked again when read; consent resets when you reload the app.</small></span></label>}
                            {tools.some(tool=>HOSTED_WORK_PRIVATE_GRAPH_TOOLS.has(tool.name))&&<label className="myso-room-ai-consent"><input type="checkbox" checked={privateGraphConsentRunId===run.id} disabled={busy||run.status==="reconciling"} onChange={event=>setPrivateGraphConsentRunId(event.target.checked?run.id:null)}/><span><strong>Allow this work run to use purchased private graphs</strong><small>Graph content will be decrypted through your authorized MyData session and sent to the selected hosted model for this run. Access is checked against the exact purchased graph version and audience on every read. Private results are removed before durable checkpoints; the model provider may still apply its own retention policy. Consent resets when you reload the app.</small></span></label>}
                            {tools.some(tool=>HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS.has(tool.name))&&<label className="myso-room-ai-consent"><input type="checkbox" checked={privateTaskArtifactConsentRunId===run.id} disabled={busy||run.status==="reconciling"} onChange={event=>setPrivateTaskArtifactConsentRunId(event.target.checked?run.id:null)}/><span><strong>Allow this work run to read private task deliverables</strong><small>Participant-authorized artifact bytes may be sent to the selected hosted model for this turn. They are removed from the durable run transcript before checkpointing and cleared before a resumed turn. Task participation is checked again when read; consent resets when you reload the app.</small></span></label>}
                            {(tools.some(tool=>HOSTED_WORK_ROOM_CONTENT_TOOLS.has(tool.name))||tools.some(tool=>HOSTED_WORK_PRIVATE_GRAPH_TOOLS.has(tool.name))||tools.some(tool=>HOSTED_WORK_PRIVATE_TASK_ARTIFACT_TOOLS.has(tool.name)))&&(roomHistoryConsentRunId===run.id||privateGraphConsentRunId===run.id||privateTaskArtifactConsentRunId===run.id)&&<label className="myso-room-ai-consent"><input type="checkbox" checked={privateContentShareConsentRunId===run.id} disabled={busy||run.status==="reconciling"} onChange={event=>setPrivateContentShareConsentRunId(event.target.checked?run.id:null)}/><span><strong>Allow this run to share private context with selected recipients</strong><small>Off by default. When enabled, private context may be sent through selected write tools, including custom MCP tools that are not explicitly marked read-only. Destinations can include messages, room invites, public posts, MyData grants or publications, and task delivery. Enable this only when each selected destination may receive the information. Consent resets when you reload the app.</small></span></label>}
                            <div className="myso-composer-footer"><label className="myso-sr-only" htmlFor="work-model">AI model</label><select id="work-model" value={modelId} onChange={event=>setModelId(event.target.value)} disabled={busy}><option value="">Choose a model</option>{models.map(model=><option key={model.id} value={model.id}>{model.display_name}</option>)}</select><button type="submit" className="myso-primary" disabled={busy||!input.trim()||!modelId||run.status==="reconciling"}>{busy?"Working…":"Send"}<ArrowRight size={16}/></button></div>
                            <p>Uses MySo AI credits. Automatic actions stay within your agent’s permissions.</p>
                        </form>
                    </section><aside className="myso-plan"><p className="myso-eyebrow">WORK PLAN · VERSION {run.plan.version}</p><ol>{run.plan.steps.map(step=>{const evidence=run.stepEvidence?.[step.id];return <li key={step.id}>{run.stepStatus[step.id]==="succeeded"?<Check size={17}/>:<Circle size={17}/>}<div><h3>{step.title}</h3><p>{status(run.stepStatus[step.id]??"pending")}</p>{step.taskEvidenceEvents&&step.taskEvidenceEvents.length>0&&<p>Required finalized events: {step.taskEvidenceEvents.join(", ")}</p>}{step.taskEvidenceEventAlternatives&&<div><p>Any one complete outcome group is required:</p><ul>{step.taskEvidenceEventAlternatives.map((group,index)=><li key={index}>{group.join(" + ")}</li>)}</ul></div>}{evidence&&<details><summary>{evidence.length} durable evidence reference{evidence.length===1?"":"s"}</summary><ul>{evidence.map(id=><li key={id}><code>{id}</code></li>)}</ul></details>}<ul>{step.acceptanceCriteria.map((criterion,index)=><li key={index}>{criterion}</li>)}</ul></div></li>;})}</ol><p className="myso-plan-note">A finished conversation does not confirm task delivery or settlement. Receipts are tracked separately.</p></aside></div>
                </>:creating?<form className="myso-create" onSubmit={create}><h2>{pendingTaskId?(pendingTaskOffered?"Coordinate task offer":"Coordinate accepted task"):"Define the work"}</h2>{pendingTaskId&&<p className="myso-knowledge-note">Attached to {pendingTaskOffered?"an open marketplace offer":"an accepted marketplace task"} {pendingTaskId}. The buyer run will wait for finalized seller acceptance before delivery review. Add the complete scope and delivery requirements below; a task digest alone does not contain the work instructions.</p>}<label htmlFor="new-goal">What should your agent accomplish?</label><textarea id="new-goal" rows={4} maxLength={10000} required value={goal} onChange={event=>setGoal(event.target.value)} disabled={busy}/><label htmlFor="new-criteria">How will you know it is done?</label><textarea id="new-criteria" rows={3} maxLength={2000} required value={criterion} onChange={event=>setCriterion(event.target.value)} disabled={busy}/><p>Creating a work plan does not purchase a task or start a model call. Runs use the agent’s live on-chain permissions and AI-credit balance.</p><div className="myso-toolbar"><button type="button" className="myso-secondary" onClick={()=>{setCreating(false);setPendingTaskId(undefined);setPendingTaskRole(undefined);setPendingTaskOffered(false);}} disabled={busy}>Cancel</button><button className="myso-primary" type="submit" disabled={busy}>{busy?"Saving…":"Create work"}</button></div></form>:view==="agents"&&context?<> <MySoAccountUsage/> <MySoActionApprovals ownerAddress={context.scope.owner} accountId={context.scope.accountId} network={context.scope.network}/> <MySoOrganizationInvitations agentAddress={context.derivedAddress} network={context.scope.network}/><MySoAgentAuthority ownerAddress={context.scope.owner} network={context.scope.network}/><MySoSubscriptions ownerAddress={context.scope.owner} network={context.scope.network}/><MySoPostTip ownerAddress={context.scope.owner} network={context.scope.network}/><MySoBeneficiaryTransfer ownerAddress={context.scope.owner} network={context.scope.network}/><MySoOwnerRotation ownerAddress={context.scope.owner} accountId={context.scope.accountId} network={context.scope.network} rpcUrl={context.rpcUrl} socialChain={{packageId:context.socialChain.packageId,usernameRegistryId:context.socialChain.usernameRegistryId??"",memoryRegistryId:context.socialChain.memoryRegistryId??"",clockId:context.socialChain.clockId}}/><MySoOrganizationTreasury ownerAddress={context.scope.owner} network={context.scope.network} initialOrganizationId={context.scope.organizationId??""}/><MySoOrganizationAccess organizationId={context.scope.organizationId} ownerAddress={context.scope.owner} network={context.scope.network}/><MySoPlatformAdmin ownerAddress={context.scope.owner} network={context.scope.network} platformId={context.socialChain.platformObjectId}/></>:view==="knowledge"?<MySoKnowledgeReader key={`${context?.scope.network??""}:${context?.scope.owner??""}:${context?.derivedAddress??""}:${context?.scope.organizationId??""}`} organizationId={context?.scope.organizationId} ownerAddress={context?.scope.owner} agentAddress={context?.derivedAddress} network={context?.scope.network} onRequestGraphPurchase={startGraphPurchase}/>:<>
                    {view==="rooms"&&selectedRoom&&<section className="myso-room-history" aria-label="Encrypted room history" aria-busy={roomHistoryLoading}><div className="myso-room-history-heading"><div><p className="myso-eyebrow">ROOM HISTORY</p><h2>{title(selectedRoom,"rooms")}</h2></div><button type="button" className="myso-icon-button" aria-label="Close room history" onClick={closeRoomHistory}><X size={18}/></button></div><p className="myso-room-disclosure">Opening this room displays decrypted message text here on your screen. It is not added to the work transcript. Only signature-verified content is shown; room order and message state are relayer metadata, not proof of complete history or task delivery.</p>{typeof selectedRoom.groupUuid==="string"&&<section className="myso-room-receipts" aria-label="Room delivery and read receipts"><div className="myso-room-history-heading"><div><h3>Room receipts</h3><p className="myso-room-disclosure">Peer-visible delivery and read markers from the messaging relayer.</p></div><button type="button" className="myso-secondary" disabled={roomReceiptsLoading} onClick={()=>void loadRoomReceipts(selectedRoom.groupUuid as string)}>{roomReceiptsLoading?"Refreshing…":"Refresh receipts"}</button></div>{roomReceiptsLoading&&!roomReceipts?<p className="myso-loading" role="status">Checking room access and loading receipts…</p>:roomReceipts?<><ul>{roomReceipts.members.map(member=><li key={member.member}><code>{member.member}</code><span>Delivered through {compareDecimal(member.deliveredUpto,"0")<0?"none":"#"+member.deliveredUpto} · Read through {compareDecimal(member.readUpto,"0")<0?"none":"#"+member.readUpto}</span></li>)}</ul><button type="button" className="myso-secondary" disabled={roomReceiptUpdating||visibleReadTarget()===undefined} onClick={()=>void markVisibleRoomRead()}>{roomReceiptUpdating?"Updating read receipt…":"Mark verified messages as read"}</button></>:<p>Receipts are unavailable for this room.</p>}</section>}{roomHistoryLoading&&!roomHistory&&<p className="myso-loading" role="status">Checking room permission and reading encrypted history…</p>}{roomHistory&&<><ol className="myso-room-messages">{roomHistory.entries.map(entry=><li key={`${entry.order}:${entry.messageId}`}><div><span>{entry.status==="verified_content"?"Verified message":entry.status.replaceAll("_"," ")}</span><small>Order {entry.order}</small></div>{entry.status==="verified_content"?<><p>{entry.content.text}</p><small>Signature verified · sender {entry.content.senderAddress}</small></>:<p>Message text is unavailable or did not pass signature verification.</p>}</li>)}</ol>{roomHistory.hasNext&&roomHistory.nextCursor&&<button type="button" className="myso-secondary" disabled={roomHistoryLoading} onClick={()=>void loadRoomHistory(selectedRoom,roomHistory.nextCursor)}>{roomHistoryLoading?"Loading…":"Load earlier messages"}</button>}</>}{context&&typeof selectedRoom.groupUuid==="string"&&<MySoRoomConversation key={`${selectedRoom.groupUuid}:${roomViewKey}`} context={context} room={{groupUuid:selectedRoom.groupUuid,groupId:typeof selectedRoom.groupId==="string"?selectedRoom.groupId:undefined}} onReconnect={refreshCustodySession}/>}</section>}
                    {(view==="tasks"||view==="agent_tasks")&&<div className="myso-segment" aria-label="Your task role"><button aria-pressed={role==="seller"} onClick={()=>{setRole("seller");setOffset(0);}}>Selling work</button><button aria-pressed={role==="buyer"} onClick={()=>{setRole("buyer");setOffset(0);}}>Buying work</button></div>}
                    {view==="marketplace"&&<p className="myso-knowledge-note">Open offers from the Task Marketplace. The indexer may lag chain state; check current task terms and your agent’s live on-chain permissions and per-action MYSO limit before accepting.</p>}
                    {view==="marketplace"&&marketStats&&<section className="myso-market-stats" aria-label="Task Marketplace indexed overview"><div><strong>{marketStats.openOffers}</strong><span>Open offers</span></div><div><strong>{marketStats.accepted}</strong><span>In progress</span></div><div><strong>{marketStats.delivered}</strong><span>Delivered</span></div><div><strong>{marketStats.disputed}</strong><span>Disputed</span></div><div><strong>{marketStats.settledLast24h}</strong><span>Settled in 24h</span></div><div><strong>{marketStats.activeAgents}</strong><span>Active sellers</span></div></section>}
                    {view==="marketplace"&&context&&<MySoTaskOfferComposer context={context} sellers={marketSellers} tools={tools}/>}
                    {view==="marketplace"&&(marketSellers.length>0||marketSellerOffset>0)&&<section className="myso-market-sellers" aria-label="Indexed active sellers"><div className="myso-market-sellers-heading"><div><p className="myso-eyebrow">SELLER DIRECTORY</p><h2>People and agents ready to work</h2></div><span>Indexed preview · chain rechecks eligibility</span></div>{marketSellers.length>0?<div className="myso-market-seller-list">{marketSellers.map(seller=><article className="myso-market-seller" key={seller.agentObjectId}><div><strong>{seller.label||"MySocial agent"}</strong><span>{seller.reviewCount?`${seller.score.toFixed(1)} / 5 · ${seller.reviewCount} ${seller.reviewCount===1?"review":"reviews"}`:"No reviews yet"}</span></div><small>{seller.settledCount} settled tasks · agent {seller.agentObjectId.slice(0,10)}...</small>{seller.expiresAtMs!==null&&<small>Indexed expiry {date(seller.expiresAtMs)}</small>}</article>)}</div>:<p>No sellers are listed on this page.</p>}<div className="myso-market-seller-pagination"><button type="button" className="myso-secondary" disabled={loading||marketSellerOffset===0} onClick={()=>setMarketSellerOffset(value=>Math.max(0,value-20))}><ArrowLeft size={15}/>Previous sellers</button><span>Page {marketSellerOffset/20+1}</span><button type="button" className="myso-secondary" disabled={loading||marketSellers.length<20||marketSellerOffset>=100000} onClick={()=>setMarketSellerOffset(value=>Math.min(100000,value+20))}>More sellers<ArrowRight size={15}/></button></div></section>}
                    {view==="marketplace"&&acceptedSubmission&&<div className="myso-settlement-receipt"><p className="myso-knowledge-note" role="status">Acceptance transaction submitted for {acceptedSubmission.taskId}. Confirm its finalized TaskAccepted event before starting work. Transaction {acceptedSubmission.digest}</p><button type="button" className="myso-secondary" disabled={acceptReceiptLoading} onClick={()=>void verifyTaskAcceptance(acceptedSubmission)}>{acceptReceiptLoading?"Checking fullnode…":"Verify acceptance receipt"}</button>{acceptReceipt&&sameObjectId(acceptReceipt.taskId,acceptedSubmission.taskId)&&<p className="myso-knowledge-note" role="status">{acceptReceipt.status==="finalized"?"Finalized TaskAccepted event verified for this seller agent.":`Acceptance receipt status: ${acceptReceipt.status.replaceAll("_"," ")}`}</p>}</div>}
                    {selectedTask&&(view==="tasks"||view==="agent_tasks")&&<section className="myso-task-detail" aria-label="Participant task details"><div className="myso-room-history-heading"><div><p className="myso-eyebrow">TASK DETAILS · {selectedTask.taskId}</p><h2>{selectedTask.title}</h2></div><button type="button" className="myso-icon-button" aria-label="Close task details" onClick={()=>setSelectedTask(null)}><X size={18}/></button></div><p className="myso-status">{["Offered","Accepted","Delivered","Settled","Refunded","Cancelled","Disputed"][selectedTask.status]??"Unknown state"} · indexer record</p><dl className="myso-knowledge-terms"><div><dt>Buyer</dt><dd>{selectedTask.buyerPrincipal}{selectedTask.buyerAgentId?` · agent ${selectedTask.buyerAgentId}`:""}</dd></div><div><dt>Seller</dt><dd>{selectedTask.sellerPrincipal} · agent {selectedTask.sellerAgentId}</dd></div><div><dt>Private room</dt><dd>{selectedTask.roomGroupId??"No room linked to this task"}</dd></div><div><dt>Platform fee rate</dt><dd>{selectedTask.platformFeeBps} bps</dd></div><div><dt>Ecosystem fee rate</dt><dd>{selectedTask.ecosystemFeeBps} bps</dd></div><div><dt>Created</dt><dd>{date(selectedTask.createdAtMs)}</dd></div><div><dt>Accept by</dt><dd>{date(selectedTask.acceptDeadlineMs)}</dd></div>{selectedTask.acceptedAtMs!==null&&<div><dt>Accepted</dt><dd>{date(selectedTask.acceptedAtMs)}</dd></div>}{selectedTask.deliveryDeadlineMs!==null&&<div><dt>Deliver by</dt><dd>{date(selectedTask.deliveryDeadlineMs)}</dd></div>}{selectedTask.deliveredAtMs!==null&&<div><dt>Delivered</dt><dd>{date(selectedTask.deliveredAtMs)}</dd></div>}{selectedTask.settleDeadlineMs!==null&&<div><dt>Settle by</dt><dd>{date(selectedTask.settleDeadlineMs)}</dd></div>}{selectedTask.settledAtMs!==null&&<div><dt>Settled</dt><dd>{date(selectedTask.settledAtMs)}</dd></div>}{selectedTask.reviewDeadlineMs!==null&&<div><dt>Review deadline</dt><dd>{date(selectedTask.reviewDeadlineMs)}</dd></div>}<div><dt>Task transaction reference</dt><dd>{selectedTask.transactionId}</dd></div></dl>{selectedTask.status===0&&sameObjectId(selectedTask.buyerPrincipal,context?.scope.owner)&&sameObjectId(selectedTask.buyerMemoryAccountId,context?.scope.accountId)&&(selectedTask.buyerAgentId===null||sameObjectId(selectedTask.buyerAgentId,context?.scope.agentId))&&<section className="myso-settlement-receipt" aria-label="Cancel task offer"><h3>Cancel open offer</h3><p>This returns the escrow to the buyer. The seller will no longer be able to accept this offer.</p><button type="button" className="myso-secondary" disabled={cancellingTask!==null||!tools.some(tool=>tool.name==="task_cancel_offer")} onClick={()=>void cancelTaskOffer(selectedTask)}>{cancellingTask===selectedTask.taskId?"Submitting cancellation…":"Cancel offer"}</button>{cancelOfferSubmission?.taskId===selectedTask.taskId&&<div><p className="myso-knowledge-note" role="status">Cancellation transaction submitted. Verify the finalized TaskCancelled event before treating the offer as cancelled. Transaction {cancelOfferSubmission.digest}</p><button type="button" className="myso-secondary" disabled={cancelOfferReceiptLoading} onClick={()=>void verifyTaskOfferCancellation(cancelOfferSubmission)}>{cancelOfferReceiptLoading?"Checking fullnode…":"Verify cancellation receipt"}</button>{cancelOfferReceipt&&<p className="myso-knowledge-note" role="status">{cancelOfferReceipt.status==="finalized"?"Finalized buyer cancellation event verified; escrow return is recorded on chain.":"Cancellation receipt status: "+cancelOfferReceipt.status.replaceAll("_"," ")}</p>}</div>}</section>}<section className="myso-task-history" aria-label="Task lifecycle history"><h3>Task history</h3><p className="myso-knowledge-note">History is indexed; each digest is checked against the exact event sequence, task, event type, successful effects and checkpoint. Rows without matching fullnode evidence remain previews.</p>{selectedTask.history.length===0?<p>No indexed transitions are available yet.</p>:<ol>{selectedTask.history.map(event=><li key={`${event.sourceEventId}:${event.eventType}`}><strong>{event.eventType.replaceAll("_"," ").replaceAll("."," · ")}</strong><span>{date(event.occurredAtMs)}</span><small>{event.verification.replaceAll("_"," ")}{event.status!==null?` · indexed status ${event.status}`:""}</small>{event.digest&&<code title={event.digest}>{event.digest}</code>}</li>)}</ol>}{selectedTask.nextHistoryOffset!==null&&selectedTask.nextHistoryOffset<=100000&&<button type="button" className="myso-secondary" disabled={taskHistoryLoading} onClick={()=>void loadMoreTaskHistory()}>{taskHistoryLoading?"Loading history…":"Load more task history"}</button>}{selectedTask.nextHistoryOffset!==null&&selectedTask.nextHistoryOffset>100000&&<p className="myso-knowledge-note">The indexed task-history reader has reached its 100,000-row offset limit.</p>}</section>{selectedTask.roomGroupId&&(selectedTask.status===0||selectedTask.status===1)&&(sameObjectId(selectedTask.buyerPrincipal,context?.scope.owner)&&!!selectedTask.buyerAgentId&&sameObjectId(selectedTask.buyerAgentId,context?.scope.agentId)||sameObjectId(selectedTask.sellerPrincipal,context?.scope.owner)&&sameObjectId(selectedTask.sellerAgentId,context?.scope.agentId))&&<button type="button" className="myso-secondary" disabled={bindingTaskRoom!==null||!tools.some(tool=>tool.name==="messaging_bind_room_to_task")} onClick={()=>void bindTaskRoom(selectedTask)}>{bindingTaskRoom===selectedTask.taskId?"Linking private room…":"Link private room to task"}<ArrowRight size={16}/></button>}{roomBindingSubmission?.taskId===selectedTask.taskId&&<p className="myso-knowledge-note">Room-link transaction submitted: {roomBindingSubmission.transactionDigest}. The room list updates after the indexer processes the event.</p>}{selectedTask.reviews.length>0&&<p className="myso-knowledge-note">Indexed reviews: {selectedTask.reviews.map(review=>`${review.stars} stars · ${date(review.reviewedAtMs)}`).join("; ")}</p>}{(selectedTask.status===0||selectedTask.status===1)&&sameObjectId(selectedTask.buyerPrincipal,context?.scope.owner)&&!!selectedTask.buyerAgentId&&sameObjectId(selectedTask.buyerAgentId,context?.scope.agentId)&&<button type="button" className="myso-secondary" disabled={busy} onClick={()=>startTaskCoordination(selectedTask)}>{selectedTask.status===0?"Coordinate offer as buyer":"Coordinate as buyer"}<ArrowRight size={16}/></button>}{selectedTask.status===1&&sameObjectId(selectedTask.sellerPrincipal,context?.scope.owner)&&sameObjectId(selectedTask.sellerAgentId,context?.scope.agentId)&&<button type="button" className="myso-secondary" onClick={()=>startTaskCoordination(selectedTask)}>Coordinate as seller<ArrowRight size={16}/></button>}<p className="myso-knowledge-note">Details are a participant-scoped indexer view and can lag chain state. Check a current chain receipt before relying on a transition.</p></section>}
                    {selectedTask&&(view==="tasks"||view==="agent_tasks")&&<MySoTaskDispute task={selectedTask} scope={context?.scope??null} enabled={tools.some(tool=>tool.name==="task_open_dispute")} onUpdated={()=>void openTaskDetails({taskId:selectedTask.taskId})}/>}
                    {selectedTask&&(view==="tasks"||view==="agent_tasks")&&<MySoTaskDisputeResponse task={selectedTask} scope={context?.scope??null} enabled={name=>tools.some(tool=>tool.name===name)} onUpdated={()=>void openTaskDetails({taskId:selectedTask.taskId})}/>}
                    {selectedTask&&(view==="tasks"||view==="agent_tasks")&&<MySoTaskDisputeAgreement task={selectedTask} scope={context?.scope??null} enabled={name=>tools.some(tool=>tool.name===name)} onUpdated={()=>void openTaskDetails({taskId:selectedTask.taskId})}/>}
                    {selectedTask&&(view==="tasks"||view==="agent_tasks")&&<MySoTaskDisputeAppeal task={selectedTask} scope={context?.scope??null} enabled={name=>tools.some(tool=>tool.name===name)} onUpdated={()=>void openTaskDetails({taskId:selectedTask.taskId})}/>}
                    {selectedTask&&(view==="tasks"||view==="agent_tasks")&&<MySoTaskDisputeEvidence task={selectedTask} scope={context?.scope??null} enabled={name=>tools.some(tool=>tool.name===name)} onUpdated={()=>void openTaskDetails({taskId:selectedTask.taskId})}/>}
                    {selectedTask&&(view==="tasks"||view==="agent_tasks")&&<MySoTaskRefund task={selectedTask} scope={context?.scope??null} enabled={name=>tools.some(tool=>tool.name===name)} onUpdated={()=>void openTaskDetails({taskId:selectedTask.taskId})}/>}
                    {selectedTask?.status===1&&(view==="tasks"||view==="agent_tasks")&&sameObjectId(selectedTask.sellerPrincipal,context?.scope.owner)&&sameObjectId(selectedTask.sellerAgentId,context?.scope.agentId)&&<section className="myso-settlement-receipt" aria-label="Deliver accepted task">
                        <h3>Deliver to buyer</h3>
                        <p>Select up to 10 files with 480 KiB total source data. MySo Agents packages them with a SHA-256 manifest into one ZIP (up to 512 KiB), stores that package in private Cloudflare R2, and releases it only to authenticated task participants. The on-chain delivery receipt binds the buyer to the exact ZIP bytes.</p>
                        <label htmlFor="task-delivery-file">Artifact files</label>
                        <input id="task-delivery-file" type="file" multiple disabled={uploadingTask!==null||deliveringTask!==null} onChange={event=>{setDeliveryFiles(Array.from(event.target.files??[]));setDeliveryUploadAckKey("");}} />
                        {deliveryFiles.length>0&&<><ul className="myso-delivery-files">{deliveryFiles.map((file,index)=><li key={`${file.name}:${file.size}:${file.lastModified}:${index}`}><span>{file.name}</span><small>{(file.size/1024).toFixed(1)} KiB</small></li>)}</ul><label className="myso-room-ai-consent"><input type="checkbox" checked={deliveryUploadAckKey===taskDeliverySelectionKey(selectedTask.taskId,deliveryFiles)} disabled={uploadingTask!==null||deliveringTask!==null} onChange={event=>setDeliveryUploadAckKey(event.target.checked?taskDeliverySelectionKey(selectedTask.taskId,deliveryFiles):"")}/><span><strong>Share these selected files with the task buyer</strong><small>Review every file first. They will be packaged with a manifest, stored in private R2, and become available to authenticated task participants after delivery.</small></span></label></>}
                        <button type="button" className="myso-secondary" disabled={!deliveryFiles.length||deliveryFiles.length>10||deliveryFiles.some(file=>file.size<1)||deliveryFiles.reduce((sum,file)=>sum+file.size,0)>480*1024||deliveryUploadAckKey!==taskDeliverySelectionKey(selectedTask.taskId,deliveryFiles)||uploadingTask!==null||deliveringTask!==null||!tools.some(tool=>tool.name==="task_upload_deliverable")} onClick={()=>void uploadTaskArtifact(selectedTask)}>{uploadingTask===selectedTask.taskId?"Packaging and uploading…":"Package and upload files"}</button>
                        {(deliveryFiles.length>10||deliveryFiles.reduce((sum,file)=>sum+file.size,0)>480*1024)&&<p className="myso-knowledge-note" role="alert">Choose no more than 10 files and keep their combined size at or below 480 KiB.</p>}
                        <form onSubmit={event=>{event.preventDefault();void deliverTask(selectedTask);}}>
                            <label htmlFor="task-delivery-uri">R2 artifact reference</label><input id="task-delivery-uri" type="text" required pattern="r2://0x[0-9a-fA-F]{64}/[0-9a-fA-F]{64}" maxLength={140} value={deliveryUri} readOnly disabled={deliveringTask!==null} placeholder="r2://0x…/…" />
                            <label htmlFor="task-delivery-digest">Artifact SHA-256</label><input id="task-delivery-digest" required pattern="[0-9a-fA-F]{64}" maxLength={64} value={deliveryDigest} readOnly disabled={deliveringTask!==null} placeholder="64 hexadecimal characters" />
                            <button type="submit" className="myso-secondary" disabled={deliveringTask!==null||uploadingTask!==null||!tools.some(tool=>tool.name==="task_deliver")||!deliveryUri.trim()||! /^[0-9a-fA-F]{64}$/.test(deliveryDigest)}>{deliveringTask===selectedTask.taskId?"Submitting delivery…":"Submit task delivery"}</button>
                        </form>
                        {deliverySubmission?.taskId===selectedTask.taskId&&<div><p className="myso-knowledge-note" role="status">Delivery transaction submitted. Verify the finalized TaskDelivered event before treating the task as delivered. Transaction {deliverySubmission.digest}</p><button type="button" className="myso-secondary" disabled={deliveryReceiptLoading} onClick={()=>void verifyTaskDelivery(deliverySubmission)}>{deliveryReceiptLoading?"Checking fullnode…":"Verify delivery receipt"}</button>{deliveryReceipt&&<p className="myso-knowledge-note" role="status">{deliveryReceipt.status==="finalized"?"Finalized artifact digest and URI verified against TaskDelivered.":"Delivery receipt status: "+deliveryReceipt.status.replaceAll("_"," ")}</p>}</div>}
                        {!tools.some(tool=>tool.name==="task_upload_deliverable")&&<p className="myso-knowledge-note">Artifact upload is unavailable to the connected agent’s current permissions.</p>}
                        {!tools.some(tool=>tool.name==="task_deliver")&&<p className="myso-knowledge-note">Task delivery is unavailable to the connected agent’s current permissions.</p>}
                    </section>}
                    {selectedTask?.status===3&&(view==="tasks"||view==="agent_tasks")&&taskReviewRole(selectedTask,context)&&selectedTask.reviewDeadlineMs!==null&&selectedTask.reviewDeadlineMs>=Date.now()&&!selectedTask.reviews.some(review=>review.raterRole===(taskReviewRole(selectedTask,context)==="buyer"?1:2))&&<section className="myso-settlement-receipt" aria-label="Review settled task"><h3>Review this task</h3><p>Your review is recorded on chain and contributes to participant reputation. One review is allowed for this side of the settled task before {date(selectedTask.reviewDeadlineMs)}.</p><label htmlFor="task-review-stars">Rating</label><select id="task-review-stars" value={reviewStars} onChange={event=>setReviewStars(Number(event.target.value))} disabled={busy}><option value={5}>5 · Excellent</option><option value={4}>4 · Good</option><option value={3}>3 · Satisfactory</option><option value={2}>2 · Needs improvement</option><option value={1}>1 · Poor</option></select><button type="button" className="myso-secondary" disabled={busy||!tools.some(tool=>tool.name==="task_review")||reviewSubmission?.taskId===selectedTask.taskId&&reviewSubmission.raterRole===taskReviewRole(selectedTask,context)} onClick={()=>void submitTaskReview(selectedTask)}>{busy?"Submitting review…":"Submit on-chain review"}</button>{reviewSubmission?.taskId===selectedTask.taskId&&<div><p className="myso-knowledge-note" role="status">{reviewSubmission.raterRole} review submitted for {reviewSubmission.stars} star{reviewSubmission.stars===1?"":"s"}. Transaction {reviewSubmission.transactionDigest}</p><button type="button" className="myso-secondary" disabled={reviewReceiptLoading} onClick={()=>void verifyTaskReview(reviewSubmission)}>{reviewReceiptLoading?"Checking fullnode…":"Verify review receipt"}</button>{reviewReceipt&&reviewReceipt.digest===reviewSubmission.transactionDigest&&<p className="myso-knowledge-note" role="status">{reviewReceipt.status==="finalized"?"Finalized TaskReviewSubmitted event verified.":`Review receipt status: ${reviewReceipt.status.replaceAll("_"," ")}`}</p>}</div>}</section>}
                    {selectedTask?.status===2&&(view==="tasks"||view==="agent_tasks")&&sameObjectId(selectedTask.buyerAgentId,context?.scope.agentId)&&<section className="myso-settlement-receipt" aria-label="Settle delivered task"><h3>Review and settle</h3><p>Settlement releases the escrow to the seller. The current delivered state is an indexer preview; the transaction checks task state, buyer authority and agent spending policy on chain.</p><button type="button" className="myso-secondary" disabled={settlingTask!==null||!tools.some(tool=>tool.name==="task_settle")} onClick={()=>void settleTask(selectedTask)}>{settlingTask===selectedTask.taskId?"Submitting settlement…":"Pay seller and settle"}</button>{settlementSubmission?.taskId===selectedTask.taskId&&<p className="myso-knowledge-note" role="status">Settlement transaction submitted. Verify the finalized receipt after the task index updates. Transaction {settlementSubmission.digest}</p>}</section>}
                    {selectedTask?.status===3&&(view==="tasks"||view==="agent_tasks")&&<section className="myso-settlement-receipt" aria-label="Task settlement receipt"><h3>Settlement verification</h3><p>A fresh fullnode query checks the finalized settlement event against the participant-scoped indexed receipt.</p><button type="button" className="myso-secondary" disabled={taskSettlementLoading} onClick={()=>void verifyTaskSettlement(selectedTask.taskId)}>{taskSettlementLoading?"Checking fullnode…":"Verify settlement receipt"}</button>{taskSettlement&&(!taskSettlement.settled?<p role="status">The task is not currently indexed as settled.</p>:<div className="myso-verified-receipt" role="status"><strong>Finalized settlement event verified</strong><span>Receipt {taskSettlement.receipt.receiptId}</span><span>Settled {date(taskSettlement.receipt.settledAtMs)}</span><span>Transaction {taskSettlement.transactionDigest}</span></div>)}</section>}
                    {selectedTask?.status===3&&(view==="tasks"||view==="agent_tasks")&&<section className="myso-settlement-receipt" aria-label="Acceptance result"><h3>Acceptance result</h3><p>Each side’s on-chain review is the acceptance result for this settled task. Indexed reviews are previews; the receipt check confirms the finalized on-chain event.</p><ul className="myso-acceptance-list">{(["buyer","seller"] as const).map(side=>{const review=selectedTask.reviews.find(item=>item.raterRole===(side==="buyer"?1:2));const submission=reviewSubmission?.taskId===selectedTask.taskId&&reviewSubmission.raterRole===side?reviewSubmission:null;const receipt=submission&&reviewReceipt?.digest===submission.transactionDigest?reviewReceipt:null;return <li key={side}><span className="myso-acceptance-side">{side==="buyer"?"Buyer review":"Seller review"}</span>{review?<span className="myso-acceptance-stars" aria-label={`${review.stars} of 5 stars`}>{"★".repeat(review.stars)}<span aria-hidden="true">{"☆".repeat(Math.max(0,5-review.stars))}</span></span>:submission?<span className="myso-acceptance-stars" aria-label={`${submission.stars} of 5 stars, not indexed yet`}>{"★".repeat(submission.stars)}<span aria-hidden="true">{"☆".repeat(Math.max(0,5-submission.stars))}</span></span>:<span className="myso-acceptance-missing">Not submitted yet</span>}{review&&<small>{date(review.reviewedAtMs)}</small>}<div className="myso-acceptance-proof">{receipt?<span role="status">{receipt.status==="finalized"?"Finalized TaskReviewSubmitted event verified":`Receipt status: ${receipt.status.replaceAll("_"," ")}`}</span>:submission?<button type="button" className="myso-text-button" disabled={reviewReceiptLoading} onClick={()=>void verifyTaskReview(submission)}>{reviewReceiptLoading?"Checking fullnode…":"Verify review receipt"}</button>:review?<small>Indexed review. Its transaction isn’t stored in this browser, so it isn’t re-verified here.</small>:null}</div></li>;})}</ul></section>}
                    {taskLoading&&<p className="myso-loading" role="status">Loading participant task details…</p>}
                    {view==="automations"&&<p className="myso-knowledge-note">Pausing stops new scheduled work; a run already underway may finish. Queued deliveries stay in place and can continue when the automation resumes. Review uncertain deliveries before retrying; retry only after verifying that the action never executed.</p>}
                    {view==="jury"&&<p className="myso-knowledge-note">Assignments are indexed previews for the connected juror agent. Accept, commit, reveal and fee-claim actions require a fresh case read and a finalized, case-bound receipt before they are treated as complete.</p>}
                    {view==="automations"&&<MySoAutomationJobCreate delegates={automationDelegates} models={models} loading={automationDelegateLoading} onCreate={createAutomationJob} onValidate={validateAutomationJob}/>}
                    {view==="automations"&&<MySoAutomationSimulator jobs={items.filter(item=>typeof item.id==="string"&&typeof item.name==="string").map(item=>({id:item.id as string,name:item.name as string}))} disabled={busy} onSimulate={simulateAutomationEvent}/>}
                    {view==="automations"&&<section className="myso-settlement-receipt" aria-label="Choose automation configuration to edit"><h3>Edit a paused automation</h3><p>Choose a paused automation to review and validate replacement triggers and action settings.</p><label htmlFor="automation-configuration-select">Automation</label><select id="automation-configuration-select" defaultValue="" disabled={busy} onChange={event=>{const selected=items.find(item=>item.id===event.target.value);if(selected)editAutomationConfiguration(selected);event.currentTarget.value="";}}><option value="">Choose a paused automation</option>{items.filter(item=>item.enabled===false&&typeof item.id==="string").map(item=><option key={String(item.id)} value={String(item.id)}>{typeof item.name==="string"?item.name:String(item.id)}</option>)}</select></section>}
                    {view==="automations"&&editingAutomation&&<MySoAutomationJobEdit key={editingAutomation.id} jobName={editingAutomation.name} triggerSet={editingAutomation.triggerSet} action={editingAutomation.action} onValidate={validateAutomationConfiguration} onSave={saveAutomationConfiguration} onCancel={()=>setEditingAutomation(null)}/>}
                    {view==="automations"&&<section className="myso-settlement-receipt" aria-label="Automation delegate authority"><div className="myso-market-sellers-heading"><div><p className="myso-eyebrow">SIGNING DELEGATES</p><h2>Automation authority</h2></div><button type="button" className="myso-secondary" disabled={automationDelegateLoading||!tools.some(tool=>tool.name==="automation_get_delegate_status")} onClick={()=>void loadAutomationDelegates()}>{automationDelegateLoading?"Checking chain…":"Refresh delegate status"}</button></div><p>Each status is checked against the current chain through the encrypted bridge. Replacing a stored key changes the encrypted envelope only; on-chain capability, spend limits, revocation and expiry remain authoritative.</p>{automationDelegates===null?<p>Refresh to inspect the delegates available to this connected agent.</p>:automationDelegates.length===0?<p>No automation delegates are registered for this agent.</p>:automationDelegates.map(delegate=><div key={delegate.delegate_ref} className="myso-verified-receipt"><strong>{delegate.delegate_ref} · {delegate.chainStatus.status.replaceAll("_"," ")}</strong><span>{delegate.delegate_class.replaceAll("_"," ")} · agent {delegate.agent_object_id}</span><span>{delegate.chainStatus.status==="unavailable"?"Live chain status is unavailable.":delegate.chainStatus.expires_at_ms===null?"No expiry is recorded on chain.":`Expires ${date(delegate.chainStatus.expires_at_ms)}${delegate.chainStatus.expires_in_ms!==null&&delegate.chainStatus.expires_in_ms<=0?" · expired":""}`}</span>{delegate.chainStatus.status!=="unavailable"&&delegate.chainStatus.reason&&<span>{delegate.chainStatus.reason}</span>}<small>Encrypted key {delegate.mydata_key_id} · registered {date(delegate.created_at)}</small>{delegate.allowed_action_ids.length>0&&<small>Allowed actions: {delegate.allowed_action_ids.join(", ")}</small>}</div>)}{automationDelegateHasNext&&automationDelegateCursor&&<button type="button" className="myso-secondary" disabled={automationDelegateLoading} onClick={()=>void loadAutomationDelegates(automationDelegateCursor,true)}>{automationDelegateLoading?"Loading delegates…":"Load more delegates"}</button>}</section>}
                    {view==="automations"&&context&&<MySoAutomationDelegateSetup context={context} onReconnect={refreshCustodySession} onCreated={()=>{void loadAutomationDelegates();void loadAutomationDelegateKeyEvents();}}/>}
                    {view==="automations"&&<section className="myso-settlement-receipt" aria-label="Automation delegate key history"><div className="myso-market-sellers-heading"><div><p className="myso-eyebrow">KEY CUSTODY</p><h2>Encrypted key history</h2></div><button type="button" className="myso-secondary" disabled={automationDelegateKeyEventLoading||!tools.some(tool=>tool.name==="automation_list_delegate_key_events")} onClick={()=>void loadAutomationDelegateKeyEvents()}>{automationDelegateKeyEventLoading?"Loading history…":"View key history"}</button></div><p>This service record shows encrypted envelope storage and deletion. It does not prove on-chain registration, revocation, or key erasure.</p>{automationDelegateKeyEvents?.map(event=><div key={event.id} className="myso-verified-receipt"><strong>{event.event_type.replaceAll("_"," ")} · {event.delegate_ref}</strong><span>Agent {event.agent_object_id}</span><small>Encryption key {event.mydata_key_id} · {date(event.recorded_at)}</small></div>)}{automationDelegateKeyEventHasNext&&automationDelegateKeyEventCursor&&<button type="button" className="myso-secondary" disabled={automationDelegateKeyEventLoading} onClick={()=>void loadAutomationDelegateKeyEvents(automationDelegateKeyEventCursor,true)}>{automationDelegateKeyEventLoading?"Loading history…":"Load more key events"}</button>}</section>}
                    {view==="automations"&&automationRunJob&&<section className="myso-settlement-receipt" aria-label="Automation run history"><div className="myso-market-sellers-heading"><div><p className="myso-eyebrow">AUTOMATION</p><h2>Run history</h2></div><button type="button" className="myso-secondary" disabled={automationRunLoading} onClick={()=>{const job=items.find(row=>row.id===automationRunJob);if(job)void loadAutomationRuns(job,0,false);}}>{automationRunLoading?"Refreshing…":"Refresh runs"}</button></div><p>Runs are owner-scoped records. A queued request appears only after the worker records its start; the delivery list shows queue and reconciliation state.</p>{automationRunLoading?<p className="myso-loading" role="status">Loading runs…</p>:automationRuns.length===0?<p>No runs are recorded for this automation yet.</p>:automationRuns.map(run=><div key={run.id} className="myso-verified-receipt"><strong>{run.status.replaceAll("_"," ")}</strong><span>Started {date(run.started_at)}</span><span>Attempt {run.attempt}</span>{run.finished_at&&<span>Finished {date(run.finished_at)}</span>}{run.error&&<span>Outcome: {run.error}</span>}{["running","reconciling"].includes(run.status)&&Date.parse(run.started_at)<=Date.now()-30*60*1000&&<div className="myso-room-invite"><p>This run is over 30 minutes old. The server will allow resolution only if no event-delivery record is linked. Resolving never replays work.</p><label htmlFor={`automation-run-reconcile-note-${run.id}`}>Audit note</label><textarea id={`automation-run-reconcile-note-${run.id}`} maxLength={1000} value={automationRunReconcileNotes[run.id]??""} onChange={event=>setAutomationRunReconcileNotes(current=>({...current,[run.id]:event.target.value}))} placeholder="Record how you checked this run (at least 8 characters)"/><div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={automationRunResolving!==null||(automationRunReconcileNotes[run.id]??"").trim().length<8} onClick={()=>void reconcileOrphanAutomationRun(run,"confirmed_succeeded")}>{automationRunResolving===run.id?"Resolving…":"Confirm completed"}</button><button type="button" className="myso-secondary" disabled={automationRunResolving!==null||(automationRunReconcileNotes[run.id]??"").trim().length<8} onClick={()=>void reconcileOrphanAutomationRun(run,"closed_uncertain_no_replay")}>Close as uncertain · no replay</button></div></div>}</div>)}{automationRunNextOffset!==null&&<button type="button" className="myso-secondary" disabled={automationRunLoading} onClick={()=>{const job=items.find(row=>row.id===automationRunJob);if(job)void loadAutomationRuns(job,automationRunNextOffset,true);}}>{automationRunLoading?"Loading…":"Load more runs"}</button>}</section>}
                    {view==="automations"&&items.length>0&&<section className="myso-settlement-receipt" aria-label="Automation delivery reconciliation"><h3>Review event deliveries</h3><p>Delivery history is paged newest first. Older exhausted or uncertain deliveries remain available for owner reconciliation.</p><label htmlFor="automation-delivery-job">Automation</label><select id="automation-delivery-job" value={automationDeliveryJob??""} disabled={automationDeliveryLoading} onChange={event=>{const job=items.find(row=>row.id===event.target.value);if(job)void loadAutomationDeliveries(job);else{setAutomationDeliveryJob(null);setAutomationDeliveries([]);setAutomationDeliveryNextOffset(null);}}}><option value="">Choose an automation</option>{items.filter(item=>typeof item.id==="string").map(item=><option key={String(item.id)} value={String(item.id)}>{typeof item.name==="string"?item.name:String(item.id)}</option>)}</select>{automationDeliveryJob&&<>{automationDeliveryLoading&&automationDeliveries.length===0?<p className="myso-loading" role="status">Loading deliveries…</p>:automationDeliveries.length===0?<p>No deliveries are recorded for this automation.</p>:<>{automationDeliveries.map(delivery=><div key={delivery.id} className="myso-verified-receipt"><strong>{delivery.status.replaceAll("_"," ")}</strong><span>Event {delivery.event_key}</span><span>Attempts {delivery.attempts}</span>{delivery.error&&<span>Last outcome: {delivery.error}</span>}{delivery.resolution&&<span>Resolved as {delivery.resolution.replaceAll("_"," ")} by {delivery.resolved_by??"account owner"}</span>}{delivery.resolution_note&&<span>Audit note: {delivery.resolution_note}</span>}{(delivery.status==="pending"||delivery.status==="reconciling")&&<div><label htmlFor={`automation-reconcile-note-${delivery.id}`}>{delivery.status==="pending"?"Cancellation audit note":"Reconciliation note"}</label><textarea id={`automation-reconcile-note-${delivery.id}`} maxLength={1000} value={automationReconcileNotes[delivery.id]??""} onChange={event=>setAutomationReconcileNotes(current=>({...current,[delivery.id]:event.target.value}))} placeholder={delivery.status==="pending"?"Why should this queued delivery never run? (at least 8 characters)":"Record how you verified the delivery outcome (at least 8 characters)"}/><div className="myso-toolbar">{delivery.status==="pending"?<button type="button" className="myso-secondary" disabled={busy||(automationReconcileNotes[delivery.id]??"").trim().length<8} onClick={()=>void cancelAutomationDelivery(delivery)}>Cancel before dispatch</button>:<><button type="button" className="myso-secondary" disabled={busy||(automationReconcileNotes[delivery.id]??"").trim().length<8} onClick={()=>void reconcileAutomationDelivery(delivery,"confirmed_succeeded")}>Confirm action succeeded</button><button type="button" className="myso-secondary" disabled={busy||(automationReconcileNotes[delivery.id]??"").trim().length<8} onClick={()=>void reconcileAutomationDelivery(delivery,"confirmed_not_executed_retry")}>Retry only if it never executed</button></>}</div></div>}</div>)}{automationDeliveryLoading?<p className="myso-loading" role="status">Loading more deliveries…</p>:automationDeliveryNextOffset!==null&&<button type="button" className="myso-secondary" onClick={()=>{const job=items.find(row=>row.id===automationDeliveryJob);if(job)void loadAutomationDeliveries(job,automationDeliveryNextOffset,true);}}>Load older deliveries</button>}</>}</>}</section>}
                    {view==="automations"&&automationDeliveryJob&&automationDeliveries.some(delivery=>delivery.resolution_history?.length)&&<section className="myso-settlement-receipt" aria-label="Automation resolution audit history"><h3>Resolution history</h3>{automationDeliveries.flatMap(delivery=>(delivery.resolution_history??[]).map((entry,index)=><div key={`${delivery.id}:${index}`} className="myso-verified-receipt"><strong>{entry.resolution.replaceAll("_"," ")}</strong><span>Event {delivery.event_key}</span><span>Account {entry.actor}</span><span>{entry.note}</span>{(entry.createdAt??entry.created_at)&&<small>{date((entry.createdAt??entry.created_at)!)}</small>}</div>))}</section>}
                    {view==="work"&&context?<MySoHome agentId={context.scope.agentId} agentLabel={context.label} vaultReady={workVault?.status==="ready"} unlocking={vaultBusy} onUnlock={()=>void unlockWorkCustody()} busy={busy} onStart={prompt=>createRun(prompt,HERO_CHAT_CRITERION)} runs={runs} runsLoading={loading} runOffset={offset} onRunOffset={setOffset} onOpenRun={id=>void selectRun(id)} onOpenView={openView} canAccept={canAcceptOffer} accepting={acceptingTask} onAccept={item=>void acceptTaskOffer(item)}/>:loading?<p className="myso-loading" role="status">Loading {labels[view].toLowerCase()}…</p>:count===0&&!error?<div className="myso-empty"><h2>{view==="work"?"Make room for your next idea.":view==="marketplace"?"No open offers right now.":`No ${labels[view].toLowerCase()} to show.`}</h2><p>{view==="work"?"Start with a goal and a clear definition of done. Your agent can help shape the work from there.":view==="marketplace"?"Newly offered tasks will appear here when they are indexed.":"This view shows records available to your connected agent."}</p>{view==="work"&&<button className="myso-primary" onClick={()=>setCreating(true)}>Create your first work plan<ArrowRight size={17}/></button>}</div>:<div className="myso-list">
                        {view==="work"?runs.map(item=><button key={item.id} className="myso-work-row" onClick={()=>void selectRun(item.id)} disabled={busy}><div><span className="myso-row-title">Work started {date(item.createdAt)}</span><span className="myso-row-subtitle">{status(item.status)}</span></div><ArrowRight size={18}/></button>):items.map((item,index)=><article key={String(item.taskId??item.groupId??item.receiptId??item.organizationId??item.id??index)} className="myso-record"><div><h2>{title(item,view)}</h2>{view==="automations"&&<small>{automationTriggerSummary(item.trigger_set)}</small>}<p>{view==="tasks"||view==="agent_tasks"||view==="organization_tasks"||view==="marketplace"?(typeof item.status==="number"?["Offered","Accepted","Delivered","Settled","Refunded","Cancelled","Disputed"][item.status]??"Unknown state":"State unavailable"):view==="automations"?(item.archived===true?"Archived":item.enabled?"Enabled":"Paused"):view==="rooms"?"Room metadata":view==="organizations"?"Public organization metadata":"Indexed settlement record"}</p>{view==="marketplace"&&item.status===0&&sameObjectId(item.sellerAgentId,context?.scope.agentId)&&<button type="button" className="myso-text-button" disabled={acceptingTask!==null||!tools.some(tool=>tool.name==="task_accept")} onClick={()=>void acceptTaskOffer(item)}>{acceptingTask===item.taskId?"Submitting acceptance…":"Accept this offer"}<ArrowRight size={15}/></button>}{(view==="tasks"||view==="agent_tasks")&&typeof item.taskId==="string"&&<button type="button" className="myso-text-button" disabled={taskLoading} onClick={()=>void openTaskDetails(item)}>View task details<ArrowRight size={15}/></button>}{view==="rooms"&&typeof item.groupId==="string"&&tools.some(tool=>tool.name==="messaging_list_room_members")&&<button type="button" className="myso-text-button" disabled={roomMembersLoading} onClick={()=>void loadRoomMembers(item.groupId as string)}>{roomMembersLoading&&roomMemberGroupId===item.groupId?"Checking current members…":"View current members"}<ArrowRight size={15}/></button>}{view==="rooms"&&roomMemberGroupId===item.groupId&&roomMembers&&<section className="myso-room-history" aria-label="Current room members"><h3>Current members · fullnode snapshot</h3><p className="myso-room-disclosure">These are room permissions only. They are not organization roles. Access was checked for the connected agent when this list was read. Permissions can change immediately after the snapshot.</p><ul>{roomMembers.members.map(member=><li key={member.address}><code>{member.address}</code><small>{member.permissions.length?member.permissions.map(permission=>permission.split("::").slice(-1)[0]).join(" · "):"No permissions recorded"}</small>{typeof item.groupUuid==="string"&&member.permissions.some(permission=>permission.endsWith("::MessagingReader"))&&!sameObjectId(member.address,context?.derivedAddress)&&tools.some(tool=>tool.name==="messaging_remove_members_rotate_key")&&<button type="button" className="myso-text-button" disabled={roomRemovingGroupId!==null} onClick={()=>{setRoomBulkRemoval(null);setRoomRemovalTarget({uuid:item.groupUuid as string,groupId:item.groupId as string,member:member.address});setRoomRemovalAcknowledged(false);setRoomRemovalResult(null);}}>Review removal</button>}{member.permissions.some(permission=>permission.endsWith("::MessagingReader"))&&!sameObjectId(member.address,context?.derivedAddress)&&tools.some(tool=>tool.name==="messaging_remove_members_rotate_key")&&tools.some(tool=>tool.name==="messaging_list_room_members")&&<button type="button" className="myso-text-button" disabled={roomRemovingGroupId!==null||roomBulkRemoval!==null} onClick={()=>{setRoomRemovalTarget(null);setRoomRemovalResult(null);setRoomBulkRemoval({groupId:item.groupId as string,member:member.address});}}>Remove from every room</button>}</li>)}</ul>{roomRemovalTarget&&roomRemovalTarget.groupId===item.groupId&&<div className="myso-room-invite" role="group" aria-label="Confirm room member removal"><p>Remove <code>{roomRemovalTarget.member}</code> from this room and rotate its encryption key. This revokes access to future messages after the rotation; past messages and plaintext already saved may remain accessible.</p><label><input type="checkbox" checked={roomRemovalAcknowledged} onChange={event=>setRoomRemovalAcknowledged(event.target.checked)} /> I understand past access cannot be recalled.</label><button type="button" className="myso-secondary" disabled={!roomRemovalAcknowledged||roomRemovingGroupId!==null} onClick={()=>void removeRoomMember()}>{roomRemovingGroupId===item.groupId?"Removing and verifying key rotation…":"Remove member and rotate key"}</button><button type="button" className="myso-text-button" disabled={roomRemovingGroupId!==null} onClick={()=>{setRoomRemovalTarget(null);setRoomRemovalAcknowledged(false);}}>Cancel</button></div>}{roomBulkRemoval&&roomBulkRemoval.groupId===item.groupId&&<MySoRoomBulkRemove key={roomBulkRemoval.member} member={roomBulkRemoval.member} selfAddress={context?.derivedAddress} api={api} onClose={()=>setRoomBulkRemoval(null)} onDone={()=>void loadRoomMembers(item.groupId as string)}/>}{roomRemovalResult&&sameObjectId(roomRemovalResult.groupId,item.groupId)&&<p role="status">Member removed and room key rotated on MySo. Future messages use key version {roomRemovalResult.keyVersionAfter}; previously available history cannot be recalled.</p>}{roomMembers.hasNextPage&&roomMembers.nextCursor&&<button type="button" className="myso-secondary" disabled={roomMembersLoading} onClick={()=>void loadRoomMembers(item.groupId as string,roomMembers.nextCursor!)}>{roomMembersLoading?"Loading…":"Load more members"}</button>}{typeof item.groupUuid==="string"&&tools.some(tool=>tool.name==="messaging_add_room_members")&&<form className="myso-room-invite" onSubmit={event=>{event.preventDefault();void inviteRoomMember(item.groupUuid as string,item.groupId as string);}}><h4>Invite a room reader</h4><p className="myso-room-disclosure">An invite grants this wallet access to past and future room messages and attachments. Only proceed if the room owner or admin intends to share the full history. Access cannot recall plaintext already copied or exported.</p><label>MySo wallet address<input autoComplete="off" spellCheck={false} value={roomInviteAddress} onChange={event=>setRoomInviteAddress(event.target.value)} placeholder="0x…" required pattern="0x[0-9a-fA-F]{1,64}" /></label><label><input type="checkbox" checked={roomInviteAckGroupId===item.groupId} onChange={event=>setRoomInviteAckGroupId(event.target.checked?item.groupId as string:null)} /> I understand this invitation shares existing history.</label><button type="submit" className="myso-secondary" disabled={roomInvitingGroupId!==null||roomInviteAckGroupId!==item.groupId||!roomInviteAddress.trim()}>{roomInvitingGroupId===item.groupId?"Verifying room access…":"Invite with past and future access"}</button>{roomInviteResult&&sameObjectId(roomInviteResult.groupId,item.groupId)&&<p role="status">Invitation verified on MySo. The wallet can read past and future messages.{roomInviteResult.digest?` Transaction ${roomInviteResult.digest}.`:" It already had the required permissions."}</p>}</form>}</section>}{view==="rooms"&&typeof item.groupUuid==="string"&&<button type="button" className="myso-text-button" disabled={roomHistoryLoading} onClick={()=>void loadRoomHistory(item)}>Read verified history<ArrowRight size={15}/></button>}{view==="rooms"&&typeof item.groupUuid==="string"&&typeof item.groupId==="string"&&<><MySoRoomNameEditor groupId={item.groupId} currentName={typeof item.groupName==="string"?item.groupName:""} available={tools.some(tool=>tool.name==="messaging_set_room_name")} busy={roomRenamingGroupId!==null} onRename={name=>renameRoom(item.groupUuid as string,item.groupId as string,name)}/>{item.archived===true?<small>Archived permanently on MySo. Room mutations are no longer available.</small>:<span className="myso-room-archive"><button type="button" className="myso-text-button" disabled={!ownerWalletMatches||!tools.some(tool=>tool.name==="messaging_archive_group")||roomArchivingGroupId!==null} aria-describedby={`room-archive-note-${item.groupId}`} onClick={()=>void archiveRoom(item.groupUuid as string,item.groupId as string)}>{roomArchivingGroupId===item.groupId?"Archiving room…":"Archive room"}</button><small id={`room-archive-note-${item.groupId}`}>{tools.some(tool=>tool.name==="messaging_archive_group")?ownerWalletMatches?"Requires live PermissionsAdmin for this room and your wallet signature after confirmation. This permanently pauses the room and cannot be undone.":"Connect the owner wallet to sign the irreversible archive confirmation.":"This agent lacks the messaging capability needed to request room archiving."}</small></span>}</> }{view==="rooms"&&typeof item.groupUuid!=="string"&&<small>History will be available when this room’s UUID is indexed.</small>}{(view==="tasks"||view==="agent_tasks"||view==="organization_tasks")&&typeof item.taskId==="string"&&[2,3,6].includes(Number(item.status))&&<button type="button" className="myso-text-button" disabled={artifactLoading===item.taskId} onClick={()=>void downloadTaskArtifact(item)}>{artifactLoading===item.taskId?"Verifying delivery…":"Verify delivery"}<ArrowRight size={15}/></button>}{deliveryCheck&&deliveryCheck.taskId===item.taskId&&(view==="tasks"||view==="agent_tasks"||view==="organization_tasks")&&<MySoDeliveryManifest check={deliveryCheck} onClose={()=>setDeliveryCheck(null)}/>}</div><div>{typeof item.amountMist==="string"&&<span className="myso-amount">{item.amountMist} MIST</span>}{(typeof item.createdAtMs==="number"||typeof item.settledAtMs==="number")&&<small>{date((item.createdAtMs??item.settledAtMs) as number)}</small>}{view==="automations"&&typeof item.id==="string"&&typeof item.enabled==="boolean"&&<>{item.archived!==true&&item.enabled&&<button type="button" className="myso-secondary" disabled={busy} onClick={()=>void runAutomationNow(item)}>Run now</button>}<button type="button" className="myso-secondary" disabled={automationRunLoading} onClick={()=>{if(automationRunJob===item.id){setAutomationRunJob(null);setAutomationRuns([]);setAutomationRunNextOffset(null);}else void loadAutomationRuns(item);}}>{automationRunJob===item.id?"Hide runs":"View runs"}</button><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void renameAutomation(item)}>Rename</button>{item.archived===true?<><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void restoreAutomation(item)}>Restore (paused)</button><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void deleteAutomation(item)}>Delete permanently</button></>:<><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void toggleAutomation(item)}>{item.enabled?"Pause automation":"Resume automation"}</button><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void archiveAutomation(item)}>Archive</button></>}<button type="button" className="myso-secondary" disabled={busy||typeof item.version!=="number"} onClick={()=>void cancelAutomation(item)}>Stop and clear queued work</button></>}</div></article>)}
                    </div>}
                    {view!=="work"&&<div className="myso-pagination"><button className="myso-secondary" disabled={loading||offset===0} onClick={()=>setOffset(value=>Math.max(0,value-20))}><ArrowLeft size={15}/>Previous</button><span>Page {offset/20+1}</span><button className="myso-secondary" disabled={loading||count<20} onClick={()=>setOffset(value=>Math.min(100000,value+20))}>Next<ArrowRight size={15}/></button></div>}
                </>}
            </main>
        </div>
        <footer className="myso-footer">MySo Agents · <a href="/source-notice">Source &amp; licenses</a></footer>
    </div>;
}
function GetStartedButton({ pending, onClick }: { pending: boolean; onClick: () => void }) {
        return <CalloutButton className="h-9 px-4 lg:px-10 lg:py-2" disabled={pending} onClick={onClick}>
        <span className="flex items-center gap-2 px-1.5 min-[550px]:px-2 font-medium">
            <span className="inline min-[550px]:hidden">Sign In</span>
            <span className="hidden min-[550px]:inline">Get Started</span>
            <ArrowRight className="hidden min-[550px]:inline h-4 w-4 shrink-0" />
        </span>
    </CalloutButton>;
}
export function MySoWorkspace(){return <Workspace/>;}
