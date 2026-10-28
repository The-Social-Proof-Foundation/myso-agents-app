"use client";

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown, Sparkles } from "lucide-react";
import { formatMyso } from "./myso-coin-format";

/** Home for the Work view: chat hero, recent chats, shared knowledge offers and open task offers. Every row comes from live service data. */
export const HERO_CHAT_CRITERION="The agent has answered the request and the user is satisfied.";
const SUGGESTIONS=["What did my agents do today?","Find a translator on the market","Summarize my open tasks"];
interface RunSummary {id:string;status:string;createdAt:string}
interface OwnedAgent {agentObjectId:string;active:boolean;labelPreview:{text:string;truncated:boolean}}
// Subset of the server-validated graph-offer page (src/core/contracts/mydata); the browser shell may not import contracts directly.
interface GraphOffer {mydataId:string;owner:string;tags:string[];oneTimePriceMist:string|null;subscriptionPriceMist:string|null;subscriptionDurationDays:string;createdAt:string}
interface MyDataGraphOfferPage {offers:GraphOffer[]}

async function homeApi<T>(path:string,init?:RequestInit):Promise<T>{
    const response=await fetch(`/api/myso/${path}`,{...init,cache:"no-store",headers:{...(init?.body?{"Content-Type":"application/json"}:{}),...init?.headers}});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error??"This request could not finish");
    return data as T;
}
function short(address:string){return address.length>14?`${address.slice(0,6)}…${address.slice(-4)}`:address;}
function shortDate(value:string|number){const parsed=new Date(typeof value==="string"&&/^\d+$/.test(value)?Number(value):value);return Number.isNaN(parsed.getTime())?"Date unavailable":parsed.toLocaleDateString(undefined,{month:"short",day:"numeric"});}
function runStatus(value:string){return value==="running"?"In progress":value==="yielded"?"Paused at model-turn limit":value.replaceAll("_"," ");}
function offerPrice(offer:GraphOffer){
    if(offer.oneTimePriceMist!==null)return BigInt(offer.oneTimePriceMist)===0n?"Free":`${formatMyso(offer.oneTimePriceMist)} one-time`;
    if(offer.subscriptionPriceMist!==null)return BigInt(offer.subscriptionPriceMist)===0n?"Free":`${formatMyso(offer.subscriptionPriceMist)} / ${offer.subscriptionDurationDays} days`;
    return "Price unavailable";
}

function AgentPicker({agentId,label,disabled}:{agentId:string;label:string;disabled:boolean}){
    const [open,setOpen]=useState(false);const [agents,setAgents]=useState<OwnedAgent[]|null>(null);const [error,setError]=useState("");const [binding,setBinding]=useState<string|null>(null);
    const root=useRef<HTMLDivElement>(null);
    useEffect(()=>{
        if(!open)return;
        const close=(event:MouseEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};
        const escape=(event:globalThis.KeyboardEvent)=>{if(event.key==="Escape")setOpen(false);};
        document.addEventListener("mousedown",close);document.addEventListener("keydown",escape);
        return()=>{document.removeEventListener("mousedown",close);document.removeEventListener("keydown",escape);};
    },[open]);
    useEffect(()=>{
        if(!open||agents)return;let alive=true;setError("");
        void homeApi<{items:OwnedAgent[]}>("agents?limit=20").then(value=>{if(alive)setAgents(value.items.filter(item=>item.active));}).catch(reason=>{if(alive)setError(reason instanceof Error?reason.message:"Agents are unavailable");});
        return()=>{alive=false;};
    },[open,agents]);
    // Same binding rules as the Agents view: read the live authority, root agents bind as null, inactive agents are refused.
    async function choose(id:string){
        if(id.toLowerCase()===agentId.toLowerCase()){setOpen(false);return;}
        setBinding(id);setError("");
        try{
            const quote=await homeApi<{agent:{parentObjectId:string|null;effectiveAuthority:{activeNow:boolean}}}>(`agents/${encodeURIComponent(id)}/authority`);
            if(!quote.agent.effectiveAuthority.activeNow)throw new Error("This agent has no active authority right now");
            await homeApi("agents/select",{method:"POST",body:JSON.stringify({agentObjectId:quote.agent.parentObjectId===null?null:id})});
            window.location.reload();
        }catch(reason){setBinding(null);setError(reason instanceof Error?reason.message:"The selected agent could not be bound");}
    }
    return <div className="myso-agent-picker" ref={root}>
        <button type="button" className="myso-agent-pill" aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={()=>setOpen(value=>!value)}><span className="myso-agent-dot"/><span>{label}</span><ChevronDown size={13}/></button>
        {open&&<div className="myso-agent-menu" role="listbox" aria-label="Choose an agent">
            {error&&<p role="alert">{error}</p>}
            {!agents&&!error&&<p role="status">Loading agents…</p>}
            {agents?.length===0&&<p>No active agents on this account.</p>}
            {agents?.map(agent=>{const current=agent.agentObjectId.toLowerCase()===agentId.toLowerCase();return <button key={agent.agentObjectId} type="button" role="option" aria-selected={current} disabled={binding!==null} onClick={()=>void choose(agent.agentObjectId)}><span><strong>{agent.labelPreview.text||"Unnamed agent"}</strong><small>{short(agent.agentObjectId)}</small></span>{binding===agent.agentObjectId?<small>Switching…</small>:current&&<Check size={14}/>}</button>;})}
        </div>}
    </div>;
}

export function MySoHome({agentId,agentLabel,vaultReady,unlocking,onUnlock,busy,onStart,runs,runsLoading,runOffset,onRunOffset,onOpenRun,onOpenView,canAccept,accepting,onAccept}:{
    agentId:string;agentLabel:string;vaultReady:boolean;unlocking:boolean;onUnlock:()=>void;busy:boolean;onStart:(prompt:string)=>Promise<boolean>;
    runs:RunSummary[];runsLoading:boolean;runOffset:number;onRunOffset:(offset:number)=>void;onOpenRun:(id:string)=>void;
    onOpenView:(view:"knowledge"|"marketplace")=>void;canAccept:(item:Record<string,unknown>)=>boolean;accepting:string|null;onAccept:(item:Record<string,unknown>)=>void;
}){
    const [prompt,setPrompt]=useState("");const [allRuns,setAllRuns]=useState(runOffset>0);
    const [offers,setOffers]=useState<GraphOffer[]|null>(null);const [offersError,setOffersError]=useState("");
    const [tasks,setTasks]=useState<Record<string,unknown>[]|null>(null);const [tasksError,setTasksError]=useState("");
    const input=useRef<HTMLTextAreaElement>(null);
    useEffect(()=>{
        let alive=true;
        void homeApi<MyDataGraphOfferPage>("knowledge/graph-offers",{method:"POST",body:JSON.stringify({limit:8,offset:0})}).then(value=>{if(alive)setOffers(value.offers.slice(0,4));}).catch(reason=>{if(alive)setOffersError(reason instanceof Error?reason.message:"Shared knowledge is unavailable");});
        void homeApi<{items:Record<string,unknown>[]}>("views/marketplace?offset=0&role=seller").then(value=>{if(alive)setTasks(value.items.filter(item=>item.status===0).slice(0,6));}).catch(reason=>{if(alive)setTasksError(reason instanceof Error?reason.message:"Open offers are unavailable");});
        return()=>{alive=false;};
    },[]);
    async function submit(event?:FormEvent){
        event?.preventDefault();if(!prompt.trim()||!vaultReady||busy)return;
        if(await onStart(prompt.trim()))setPrompt("");
    }
    function onKeyDown(event:KeyboardEvent<HTMLTextAreaElement>){if(event.key==="Enter"&&!event.shiftKey&&!event.nativeEvent.isComposing){event.preventDefault();void submit();}}
    const visibleRuns=allRuns?runs:runs.slice(0,5);
    return <div className="myso-home">
        <section className="myso-hero" aria-labelledby="myso-hero-title">
            <h1 id="myso-hero-title">What should your agents work on?</h1>
            <p>Ask, delegate, or pull in shared knowledge. Every action stays inside your on-chain caps.</p>
            <form className="myso-hero-composer" onSubmit={submit}>
                <div className="myso-hero-input">
                    <label htmlFor="myso-hero-prompt" className="myso-sr-only">Message {agentLabel}</label>
                    <textarea id="myso-hero-prompt" ref={input} rows={2} maxLength={10000} value={prompt} placeholder={`Ask ${agentLabel} anything…`} onChange={event=>setPrompt(event.target.value)} onKeyDown={onKeyDown} disabled={busy}/>
                    <AgentPicker agentId={agentId} label={agentLabel} disabled={busy}/>
                </div>
                <div className="myso-hero-actions">
                    {vaultReady?<small>Starts a new chat. Model calls use your agent’s live permissions and AI credits.</small>:<button type="button" className="myso-secondary" disabled={unlocking} onClick={onUnlock}>{unlocking?"Unlocking…":"Unlock encrypted work to chat"}</button>}
                    <button type="submit" className="myso-hero-send" aria-label="Start chat" disabled={!vaultReady||busy||!prompt.trim()}><ArrowUp size={18}/></button>
                </div>
            </form>
            <div className="myso-hero-suggestions">{SUGGESTIONS.map(text=><button key={text} type="button" onClick={()=>{setPrompt(text);input.current?.focus();}}><Sparkles size={13}/>{text}</button>)}</div>
        </section>
        {vaultReady&&<section className="myso-home-section" aria-labelledby="myso-recent-title">
            <div className="myso-home-heading"><div><h2 id="myso-recent-title">Recent chats</h2><p>Pick up where you and your agent left off.</p></div>{(runs.length>5||runOffset>0)&&<button type="button" className="myso-home-link" onClick={()=>{if(allRuns&&runOffset>0)onRunOffset(0);setAllRuns(value=>!value);}}>{allRuns?"Show fewer":"See all"}<ArrowRight size={14}/></button>}</div>
            {runsLoading?<p className="myso-loading" role="status">Loading chats…</p>:runs.length===0?<p className="myso-home-empty">No chats yet. Ask your agent something above to start one.</p>:<div className="myso-list">{visibleRuns.map(item=><button key={item.id} className="myso-work-row" onClick={()=>onOpenRun(item.id)} disabled={busy}><div><span className="myso-row-title">Chat started {new Date(item.createdAt).toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"})}</span><span className="myso-row-subtitle">{runStatus(item.status)}</span></div><ArrowRight size={18}/></button>)}</div>}
            {allRuns&&<div className="myso-pagination"><button className="myso-secondary" disabled={runsLoading||runOffset===0} onClick={()=>onRunOffset(Math.max(0,runOffset-20))}><ArrowLeft size={15}/>Previous</button><span>Page {runOffset/20+1}</span><button className="myso-secondary" disabled={runsLoading||runs.length<20} onClick={()=>onRunOffset(Math.min(100000,runOffset+20))}>Next<ArrowRight size={15}/></button></div>}
        </section>}
        <section className="myso-home-section" aria-labelledby="myso-knowledge-title">
            <div className="myso-home-heading"><div><h2 id="myso-knowledge-title">Shared knowledge</h2><p>Knowledge graphs offered on MySo. Open one to preview terms or buy access.</p></div><button type="button" className="myso-home-link" onClick={()=>onOpenView("knowledge")}>Browse all<ArrowRight size={14}/></button></div>
            {offersError?<p className="myso-home-empty" role="alert">{offersError}</p>:!offers?<p className="myso-loading" role="status">Loading shared knowledge…</p>:offers.length===0?<p className="myso-home-empty">No knowledge graphs are offered right now.</p>:<div className="myso-knowledge-cards">{offers.map(offer=><article key={offer.mydataId} className="myso-knowledge-card">
                <div className="myso-knowledge-card-head"><span className="myso-knowledge-avatar" aria-hidden="true">{offer.owner.slice(2,4).toUpperCase()}</span><div><strong>{short(offer.owner)}</strong><small>Listed {shortDate(offer.createdAt)}</small></div></div>
                {offer.tags.length>0?<ul className="myso-chip-row" aria-label="Topics">{offer.tags.slice(0,3).map(tag=><li key={tag}>{tag}</li>)}{offer.tags.length>3&&<li>+{offer.tags.length-3}</li>}</ul>:<p className="myso-knowledge-card-note">No topics listed</p>}
                <div className="myso-knowledge-card-foot"><span className={offerPrice(offer)==="Free"?"myso-price-free":"myso-price"}>{offerPrice(offer)}</span><button type="button" className="myso-secondary" onClick={()=>onOpenView("knowledge")}>View</button></div>
            </article>)}</div>}
        </section>
        <section className="myso-home-section" aria-labelledby="myso-market-title">
            <div className="myso-home-heading"><div><h2 id="myso-market-title">Task market</h2><p>Open work you or your agents can pick up. Rewards are held in escrow.</p></div><button type="button" className="myso-home-link" onClick={()=>onOpenView("marketplace")}>See all<ArrowRight size={14}/></button></div>
            {tasksError?<p className="myso-home-empty" role="alert">{tasksError}</p>:!tasks?<p className="myso-loading" role="status">Loading open offers…</p>:tasks.length===0?<p className="myso-home-empty">No open offers right now.</p>:<div className="myso-task-cards">{tasks.map((item,index)=><article key={String(item.taskId??index)} className="myso-task-card">
                <div className="myso-task-card-top"><span className="myso-task-tag">OPEN OFFER</span>{typeof item.amountMist==="string"&&/^\d+$/.test(item.amountMist)&&<strong>{formatMyso(item.amountMist)}</strong>}</div>
                <h3>{typeof item.title==="string"&&item.title?item.title:"Untitled task"}</h3>
                <p className="myso-task-meta">{typeof item.buyerPrincipal==="string"?`BY ${short(item.buyerPrincipal).toUpperCase()}`:"BUYER UNAVAILABLE"}{typeof item.acceptDeadlineMs==="number"&&` · ACCEPT BY ${shortDate(item.acceptDeadlineMs).toUpperCase()}`}</p>
                <div className="myso-task-card-actions"><button type="button" className="myso-secondary" onClick={()=>onOpenView("marketplace")}>Details</button>{canAccept(item)&&<button type="button" className="myso-primary" disabled={accepting!==null} onClick={()=>onAccept(item)}>{accepting===item.taskId?"Accepting…":"Accept"}</button>}</div>
            </article>)}</div>}
        </section>
    </div>;
}
