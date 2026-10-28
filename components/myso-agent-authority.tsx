"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RefreshCw } from "lucide-react";
import { MySoAgentPolicyControls } from "./myso-agent-policy-controls";

interface AgentRow {
    agentObjectId: string;
    active: boolean;
    expectedCapabilities: string;
    expectedLimitMist: string;
    labelPreview: { text: string; truncated: boolean; source: "on_chain_label_untrusted" };
}
export interface AuthorityQuote {
    supportedGrantMask: string;
    agent: AgentRow & {
        expectedPlatformScope: unknown;
        approvalRequiredCaps: string;
        delegatableCaps: string;
        expiresAtMs: string | null;
        parentObjectId: string | null;
        organizationId: string | null;
        effectiveAuthority: {
            computed: true;
            activeNow: boolean;
            accountActive: boolean;
            currentTimeMs: string;
            effectiveExecutionCapabilitiesMask: string;
            effectivePerActionSpendLimitMist: string;
            limitSemantics: "per_action_not_cumulative";
            activeChain: Array<{agentObjectId:string;parentObjectId:string|null;active:boolean;expired:boolean;expiresAtMs:string|null;depth:string}>;
            evidenceSource: "configured_fullnode_live_object_snapshot";
            executionRechecksAuthority: true;
        };
    };
    writesEnabled: boolean;
}
interface AgentPage { items: AgentRow[]; hasNextPage: boolean; nextCursor: string | null }

async function api<T>(path:string):Promise<T>{
    const response=await fetch(`/api/myso/${path}`,{cache:"no-store"});
    const data=await response.json() as {error?:string};
    if(!response.ok)throw new Error(data.error??"Agent policy could not be loaded");
    return data as T;
}
function mist(value:string){
    if(value==="unlimited")return "Unlimited";
    const amount=BigInt(value), whole=amount/1_000_000_000n, fraction=(amount%1_000_000_000n).toString().padStart(9,"0").replace(/0+$/g,"");
    return `${whole.toString()}${fraction?`.${fraction}`:""} MYSO`;
}
function time(value:string|null){
    if(value===null)return "No expiry";
    const n=Number(BigInt(value));
    return Number.isFinite(n)?new Date(n).toLocaleString():"Timestamp unavailable";
}

export function MySoAgentAuthority({ownerAddress,network}:{ownerAddress:string;network:string}){
    const [page,setPage]=useState<AgentPage|null>(null);
    const [cursor,setCursor]=useState<string|null>(null);
    const [previous,setPrevious]=useState<Array<string|null>>([]);
    const [selected,setSelected]=useState<string|null>(null);
    const [quote,setQuote]=useState<AuthorityQuote|null>(null);
    const [loading,setLoading]=useState(false);
    const [quoteLoading,setQuoteLoading]=useState(false);
    const [error,setError]=useState("");
    const [binding,setBinding]=useState("");
    const [reload,setReload]=useState(0);
    const listRequest=useRef(0);
    const quoteRequest=useRef(0);
    const load=useCallback(async()=>{
        const request=++listRequest.current;
        quoteRequest.current++;
        setLoading(true);setError("");setPage(null);setSelected(null);setQuote(null);
        try{
            const query=new URLSearchParams({limit:"20"});if(cursor)query.set("cursor",cursor);
            const result=await api<AgentPage>(`agents?${query}`);if(request===listRequest.current)setPage(result);
        }catch(reason){if(request===listRequest.current)setError(reason instanceof Error?reason.message:"Owned agents are unavailable");}
        finally{if(request===listRequest.current)setLoading(false);}
    },[cursor,reload]);
    useEffect(()=>{void load();},[load]);
    async function useAgent(agentId:string, root:boolean){
        setBinding("Saving the selected agent…");setError("");
        try{
            const response=await fetch("/api/myso/agents/select",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({agentObjectId:root?null:agentId})});
            const data=await response.json() as {error?:string};
            if(!response.ok)throw new Error(data.error??"The selected agent could not be bound");
            window.location.reload();
        }catch(reason){setBinding("");setError(reason instanceof Error?reason.message:"The selected agent could not be bound");}
    }
    async function inspect(agentId:string){
        const request=++quoteRequest.current;
        setSelected(agentId);setQuote(null);setQuoteLoading(true);setError("");
        try{const result=await api<AuthorityQuote>(`agents/${encodeURIComponent(agentId)}/authority`);if(request===quoteRequest.current)setQuote(result);}
        catch(reason){if(request===quoteRequest.current)setError(reason instanceof Error?reason.message:"The live authority snapshot is unavailable");}
        finally{if(request===quoteRequest.current)setQuoteLoading(false);}
    }
    return <section className="myso-agents-authority" aria-label="Agent authority">
        <div className="myso-agents-heading"><div><p className="myso-eyebrow">ACCOUNT POLICY</p><h2>Owned agents</h2></div><button type="button" className="myso-icon-button" aria-label="Refresh agents" disabled={loading||quoteLoading} onClick={()=>setReload(value=>value+1)}><RefreshCw size={17}/></button></div>
        <p className="myso-knowledge-note">Agent labels and list values are on-chain previews. Open an agent for its current fullnode authority snapshot. The Move contract checks authority again when an action executes.</p>
        {loading?<p className="myso-loading" role="status">Loading agents…</p>:error&&!selected?<p className="myso-knowledge-note" role="alert">{error}</p>:page?.items.length===0?<p className="myso-knowledge-note">No agents are registered to this account.</p>:<div className="myso-agent-policy-layout">
            <div className="myso-agent-policy-list" aria-label="Owned agents">
                {page?.items.map(agent=><button key={agent.agentObjectId} type="button" className="myso-agent-policy-row" aria-pressed={selected===agent.agentObjectId} onClick={()=>void inspect(agent.agentObjectId)} disabled={quoteLoading}>
                    <span><strong>{agent.labelPreview.text||"Unnamed agent"}</strong><small>{agent.agentObjectId}</small><small>{agent.active?"Agent active":"Agent inactive"} · capability mask {agent.expectedCapabilities}</small></span><ArrowRight size={17}/>
                </button>)}
                <div className="myso-agent-policy-pagination"><button type="button" className="myso-secondary" disabled={loading||previous.length===0} onClick={()=>{const next=[...previous];const value=next.pop()??null;setPrevious(next);setCursor(value);setSelected(null);setQuote(null);}}><ArrowLeft size={15}/>Previous</button><span>{page?.hasNextPage?"More agents available":"End of list"}</span><button type="button" className="myso-secondary" disabled={loading||!page?.hasNextPage||!page.nextCursor} onClick={()=>{if(!page?.nextCursor)return;setPrevious(values=>[...values,cursor]);setCursor(page.nextCursor);setSelected(null);setQuote(null);}}>Next<ArrowRight size={15}/></button></div>
            </div>
            <div className="myso-agent-policy-detail" aria-live="polite">
                {!selected?<p>Select an agent to inspect its live authority.</p>:quoteLoading?<p className="myso-loading" role="status">Reading current account and ancestor policy…</p>:quote?<>
                    <div className="myso-agent-policy-status"><span className={quote.agent.effectiveAuthority.activeNow?"myso-agent-active":"myso-agent-inactive"}>{quote.agent.effectiveAuthority.activeNow?"Effective now":"Not effective now"}</span><small>Snapshot at {time(quote.agent.effectiveAuthority.currentTimeMs)}</small></div>
                    <dl className="myso-knowledge-terms">
                        <div><dt>Capabilities</dt><dd>{quote.agent.effectiveAuthority.effectiveExecutionCapabilitiesMask} · numeric mask</dd></div>
                        <div><dt>Per-action spend limit</dt><dd>{mist(quote.agent.effectiveAuthority.effectivePerActionSpendLimitMist)}{quote.agent.effectiveAuthority.effectivePerActionSpendLimitMist==="unlimited"?"":` (${quote.agent.effectiveAuthority.effectivePerActionSpendLimitMist} MIST)`}</dd></div>
                        <div><dt>Configured limit</dt><dd>{mist(quote.agent.expectedLimitMist)} per action, not cumulative</dd></div>
                        <div><dt>Account active</dt><dd>{quote.agent.effectiveAuthority.accountActive?"Yes":"No"}</dd></div>
                        <div><dt>Agent expiry</dt><dd>{time(quote.agent.expiresAtMs)}</dd></div>
                        <div><dt>Approval-required capability mask</dt><dd>{quote.agent.approvalRequiredCaps}</dd></div>
                        <div><dt>Delegatable capability mask</dt><dd>{quote.agent.delegatableCaps}</dd></div>
                        <div><dt>Platform scope</dt><dd>{typeof quote.agent.expectedPlatformScope==="string"?quote.agent.expectedPlatformScope:JSON.stringify(quote.agent.expectedPlatformScope)}</dd></div>
                    </dl>
                    <h3>Authority chain</h3>
                    <ol className="myso-agent-authority-chain">{quote.agent.effectiveAuthority.activeChain.map((entry,index)=><li key={`${entry.agentObjectId}:${index}`}><strong>{index===0?"Selected agent":"Parent agent"}</strong><small>{entry.agentObjectId}</small><span>{entry.active&&!entry.expired?"Active":"Inactive or expired"}{entry.expiresAtMs?` · expires ${time(entry.expiresAtMs)}`:" · no expiry"}</span></li>)}</ol>
                    <p className="myso-knowledge-note">The spend ceiling applies to each action independently. This snapshot does not reserve or guarantee future authority; the native contract rechecks the account and full ancestor chain at execution.</p>
                    <MySoAgentPolicyControls quote={quote} ownerAddress={ownerAddress} network={network} onComplete={()=>void inspect(quote.agent.agentObjectId)}/>
                    <button type="button" className="myso-primary" disabled={!!binding||!quote.agent.effectiveAuthority.activeNow} onClick={()=>void useAgent(quote.agent.agentObjectId, quote.agent.parentObjectId===null)}>{quote.agent.parentObjectId===null?"Use the root agent":"Use this child agent"}</button>
                    {binding&&<p className="myso-knowledge-note" role="status">{binding}</p>}
                </>:<p className="myso-knowledge-note" role="alert">{error||"The live policy could not be read."}</p>}
            </div>
        </div>}
    </section>;
}
