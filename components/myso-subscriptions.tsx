"use client";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import { formatCoin, formatDuration } from "./myso-coin-format";
import { ownerApi, useOwnerApprovalFlow } from "./myso-owner-approval-flow";

const ENDPOINT="/api/myso/subscriptions";
type SubscriptionAction="subscribe"|"renew"|"cancel"|"enable_auto_renew"|"disable_auto_renew"|"change_payment_recipient";
interface Terms {planId:string;expectedProfileOwner:string;coinType:string;priceBaseUnits:string;durationMs:string;tierLevel?:string;planPlatformId?:string}
interface Subscription {subscriptionId:string;serviceId:string;planId:string;coinType:string;expiresAtMs:string;autoRenew:boolean;renewalCount?:string}
interface Preview {text:string;truncated:boolean}
interface Plan {terms:Terms;active:boolean;planMetadata?:{title?:Preview;description?:Preview|null}|null}
interface PlanQuote {serviceId:string;terms:Terms;planActive:boolean;serviceActive:boolean;maxRenewalPeriods:string;deploymentEnabled:boolean;planMetadata?:Plan["planMetadata"]}
interface RenewalQuote extends PlanQuote {subscription:Subscription}
interface Coin {coinObjectId:string;coinType:string;balanceBaseUnits:string}
interface CreatorService {service_id:string;profile_owner:string;payment_recipient:string;plan_count:number;subscriber_count:number;active:boolean;created_at:number;display_name?:string|null;username?:string|null}
interface RevenueRow {subscription_id?:string|null;from_address?:string;to_address?:string;amount?:number|string;creator_amount?:number|string;revenue_type?:string;payment_time?:number;time?:number|string;transaction_id?:string}

const date=(value:string)=>{const numeric=Number(value);const parsed=Number.isFinite(numeric)&&value.trim()!==""?new Date(numeric):new Date(value);return Number.isNaN(parsed.getTime())?"Time unavailable":parsed.toLocaleDateString(undefined,{year:"numeric",month:"short",day:"numeric"});};
const short=(id:string)=>id.length>14?`${id.slice(0,8)}…${id.slice(-4)}`:id;
const planTitle=(plan:{terms:Terms;planMetadata?:Plan["planMetadata"]})=>plan.planMetadata?.title?.text||`Plan ${short(plan.terms.planId)}`;

/** Pick the payment coin: only coins that cover `needed` are selectable. */
function CoinPicker({id,coins,needed,coinType,value,onChange,disabled}:{id:string;coins:Coin[]|null;needed:bigint;coinType:string;value:string;onChange:(id:string)=>void;disabled:boolean}){
    if(!coins)return <p className="myso-loading" role="status">Loading wallet coins…</p>;
    const usable=coins.filter(coin=>BigInt(coin.balanceBaseUnits)>=needed);
    if(usable.length===0)return <p className="myso-knowledge-note" role="alert">No single coin in the owner wallet covers {formatCoin(needed.toString(),coinType)}. Merge or add funds, then try again.</p>;
    return <><label htmlFor={id}>Pay from coin</label><select id={id} value={value} disabled={disabled} onChange={event=>onChange(event.target.value)}><option value="">Choose a coin…</option>{coins.map(coin=><option key={coin.coinObjectId} value={coin.coinObjectId} disabled={BigInt(coin.balanceBaseUnits)<needed}>{short(coin.coinObjectId)} · {formatCoin(coin.balanceBaseUnits,coin.coinType)}{BigInt(coin.balanceBaseUnits)<needed?" · not enough":""}</option>)}</select></>;
}

/** Owner subscriptions: quote → subscribe, and renew / cancel / auto-renew
 *  on owned subscriptions. A subscription renews the same plan; it never
 *  grants the agent or an organization the owner's entitlement. */
export function MySoSubscriptions({ownerAddress,network}:{ownerAddress:string;network:string}){
    const approval=useOwnerApprovalFlow({endpoint:ENDPOINT,storageKey:`myso-agents:subscriptions:${network}:${ownerAddress.toLowerCase()}`,ownerAddress,network,withAction:action=>({action})});
    const [subscriptions,setSubscriptions]=useState<Subscription[]|null>(null);const [listError,setListError]=useState("");const [listLoading,setListLoading]=useState(false);
    const [services,setServices]=useState<CreatorService[]|null>(null);const [servicesError,setServicesError]=useState("");const [servicesHasMore,setServicesHasMore]=useState(false);const [revenue,setRevenue]=useState<Record<string,RevenueRow[]>>({});const [revenueHasMore,setRevenueHasMore]=useState<Record<string,boolean>>({});const [revenueLoading,setRevenueLoading]=useState("");const [recipientDrafts,setRecipientDrafts]=useState<Record<string,string>>({});
    const [renewing,setRenewing]=useState<{subscriptionId:string;quote:RenewalQuote|null;coins:Coin[]|null;coinId:string}|null>(null);
    const [serviceId,setServiceId]=useState("");const [plans,setPlans]=useState<Plan[]|null>(null);const [planId,setPlanId]=useState("");
    const [quote,setQuote]=useState<PlanQuote|null>(null);const [periods,setPeriods]=useState(1);const [autoRenew,setAutoRenew]=useState(false);
    const [coins,setCoins]=useState<Coin[]|null>(null);const [coinId,setCoinId]=useState("");
    const [loading,setLoading]=useState("");const [error,setError]=useState("");
    const locked=approval.busy||approval.pending||!!loading;
    const loadList=useCallback(async()=>{
        setListLoading(true);setListError("");
        try{const page=await ownerApi<{items:Subscription[]}>(ENDPOINT,{operation:"list"});setSubscriptions(page.items);}
        catch(reason){setListError(reason instanceof Error?reason.message:"Your subscriptions are unavailable");}
        finally{setListLoading(false);}
    },[]);
    useEffect(()=>{void loadList();},[loadList]);
    const loadServices=useCallback(async(offset=0)=>{
        setServicesError("");
        try{const result=await ownerApi<{items:CreatorService[];hasMore:boolean}>(ENDPOINT,{operation:"owner-services",offset});setServices(current=>offset===0?result.items:[...(current??[]),...result.items]);setServicesHasMore(result.hasMore);}
        catch(reason){setServicesError(reason instanceof Error?reason.message:"Your creator services are unavailable");}
    },[]);
    useEffect(()=>{void loadServices();},[loadServices]);
    async function loadRevenue(serviceId:string,reset=false){
        setRevenueLoading(serviceId);
        try{const offset=reset?0:(revenue[serviceId]?.length??0);const result=await ownerApi<{items:RevenueRow[];hasMore:boolean}>(ENDPOINT,{operation:"service-revenue",serviceId,offset});setRevenue(current=>({...current,[serviceId]:reset?result.items:[...(current[serviceId]??[]),...result.items]}));setRevenueHasMore(current=>({...current,[serviceId]:result.hasMore}));}
        catch(reason){setServicesError(reason instanceof Error?reason.message:"Indexed revenue is unavailable");}
        finally{setRevenueLoading("");}
    }
    async function loadCoins(coinType:string){return (await ownerApi<{coins:Coin[]}>(ENDPOINT,{operation:"coins",coinType})).coins;}
    async function findPlans(event:FormEvent){
        event.preventDefault();setLoading("plans");setError("");setPlans(null);setPlanId("");setQuote(null);setCoins(null);setCoinId("");
        try{setPlans((await ownerApi<{items:Plan[]}>(ENDPOINT,{operation:"plans",serviceId:serviceId.trim()})).items);}
        catch(reason){setError(reason instanceof Error?reason.message:"This service's plans are unavailable");}
        finally{setLoading("");}
    }
    async function choosePlan(id:string){
        setPlanId(id);setQuote(null);setCoins(null);setCoinId("");setPeriods(1);setAutoRenew(false);setLoading("quote");setError("");
        try{const value=await ownerApi<PlanQuote>(ENDPOINT,{operation:"quote",serviceId:serviceId.trim(),planId:id});setQuote(value);setCoins(await loadCoins(value.terms.coinType));}
        catch(reason){setError(reason instanceof Error?reason.message:"This plan quote is unavailable");}
        finally{setLoading("");}
    }
    async function openRenew(subscription:Subscription){
        setRenewing({subscriptionId:subscription.subscriptionId,quote:null,coins:null,coinId:""});setError("");
        try{const value=await ownerApi<RenewalQuote>(ENDPOINT,{operation:"renewal-quote",subscriptionId:subscription.subscriptionId});const list=await loadCoins(value.terms.coinType);setRenewing(current=>current?.subscriptionId===subscription.subscriptionId?{...current,quote:value,coins:list}:current);}
        catch(reason){setRenewing(null);setError(reason instanceof Error?reason.message:"The renewal quote is unavailable");}
    }
    function run(action:SubscriptionAction,label:string,body:Record<string,unknown>){void approval.start(action,label,body,()=>{setRenewing(null);setPlanId("");setQuote(null);setCoins(null);setCoinId("");void loadList();void loadServices();});}
    const maxPeriods=quote?Math.min(Number(BigInt(quote.maxRenewalPeriods))+1,1000):1;
    const total=quote?BigInt(quote.terms.priceBaseUnits)*BigInt(periods):0n;
    const quoteReady=!!quote&&quote.deploymentEnabled&&quote.planActive&&quote.serviceActive;
    return <section className="myso-create myso-subscriptions" aria-labelledby="subscriptions-title">
        <div className="myso-agents-heading"><div><p className="myso-eyebrow">OWNER WALLET</p><h2 id="subscriptions-title">Subscriptions</h2></div><button type="button" className="myso-icon-button" aria-label="Refresh subscriptions" disabled={listLoading} onClick={()=>void loadList()}><RefreshCw size={17}/></button></div>
        <p>Subscribe to a creator’s plan or manage the ones you own. A subscription belongs to your owner wallet and renews the same plan. It does not give your agent or an organization access to your entitlement.</p>
        {approval.walletControls}
        <h3>Your creator services</h3>
        <p>Indexed service activity can lag the chain. Payout changes require the profile owner’s wallet and apply to future payments and renewals; past transfers and prepaid balances stay unchanged.</p>
        {servicesError&&<p className="myso-knowledge-note" role="alert">{servicesError}</p>}
        {services===null?<p className="myso-loading" role="status">Loading creator services…</p>:services.length===0?<p className="myso-knowledge-note">No subscription services are indexed for this account owner.</p>:<div className="myso-subscription-list">{services.map(service=>{
            const draft=recipientDrafts[service.service_id]??service.payment_recipient;
            const rows=revenue[service.service_id];
            return <article className="myso-subscription-row" key={service.service_id}>
                <div className="myso-subscription-summary"><div><strong>{service.display_name||service.username||`Service ${short(service.service_id)}`}</strong><small>{service.service_id} · {service.subscriber_count} indexed subscribers · {service.plan_count} plans</small></div><span className={service.active?"myso-agent-active":"myso-agent-inactive"}>{service.active?"Active":"Inactive"}</span></div>
                <p className="myso-knowledge-note">Current payout destination: <strong>{service.payment_recipient}</strong></p>
                <label htmlFor={`payout-${service.service_id}`}>New payout wallet</label>
                <div className="myso-toolbar"><input id={`payout-${service.service_id}`} value={draft} pattern="0x[0-9a-fA-F]{1,64}" maxLength={66} spellCheck={false} autoComplete="off" disabled={locked} onChange={event=>setRecipientDrafts(current=>({...current,[service.service_id]:event.target.value}))}/><button type="button" className="myso-primary" disabled={locked||!approval.ownerMatches||!/^0x[0-9a-fA-F]{1,64}$/.test(draft)||draft.toLowerCase()===service.payment_recipient.toLowerCase()} onClick={()=>run("change_payment_recipient",`Change future payouts for ${short(service.service_id)} to ${draft}`,{serviceId:service.service_id,newRecipient:draft})}>Review and sign<ArrowRight size={16}/></button></div>
                <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={locked||revenueLoading===service.service_id} onClick={()=>void loadRevenue(service.service_id,!rows||!revenueHasMore[service.service_id])}>{revenueLoading===service.service_id?"Loading…":rows&&revenueHasMore[service.service_id]?"Load more indexed revenue":rows?"Refresh indexed revenue":"Load indexed revenue history"}</button></div>
                {rows&&<div className="myso-subscription-list" aria-label="Indexed revenue history">{rows.length===0?<p className="myso-knowledge-note">No indexed revenue rows yet.</p>:rows.map((row,index)=><div className="myso-subscription-row" key={row.transaction_id??`${row.subscription_id??"revenue"}-${index}`}><strong>{row.revenue_type??"Subscription payment"}</strong><small>Creator amount: {row.creator_amount??row.amount??"Unavailable"} base units · {row.time??row.payment_time?date(String(row.time??row.payment_time)):"Time unavailable"}</small><small>{row.transaction_id??row.subscription_id??"Indexed record"}</small></div>)}</div>}
            </article>;
        })}</div>}
        {servicesHasMore&&<button type="button" className="myso-secondary" disabled={locked} onClick={()=>void loadServices(services?.length??0)}>Load more creator services</button>}
        <h3>Your subscriptions</h3>
        {listLoading?<p className="myso-loading" role="status">Loading subscriptions…</p>:listError?<p className="myso-knowledge-note" role="alert">{listError}</p>:subscriptions?.length===0?<p className="myso-knowledge-note">You don’t own any subscriptions yet. Find a plan below to subscribe.</p>:<div className="myso-subscription-list">{subscriptions?.map(subscription=>{
            const expired=Number(subscription.expiresAtMs)<=Date.now();const open=renewing?.subscriptionId===subscription.subscriptionId;
            return <article className="myso-subscription-row" key={subscription.subscriptionId}>
                <div className="myso-subscription-summary"><div><strong>Plan {short(subscription.planId)}</strong><small>Service {short(subscription.serviceId)} · {subscription.subscriptionId}</small></div><span className={expired?"myso-agent-inactive":"myso-agent-active"}>{expired?`Expired ${date(subscription.expiresAtMs)}`:`${subscription.autoRenew?"Renews":"Ends"} ${date(subscription.expiresAtMs)}`}</span></div>
                <div className="myso-toolbar">
                    <button type="button" className="myso-secondary" disabled={locked||!approval.ownerMatches} aria-expanded={open} onClick={()=>open?setRenewing(null):void openRenew(subscription)}>Renew</button>
                    <button type="button" className="myso-secondary" disabled={locked||!approval.ownerMatches} onClick={()=>run(subscription.autoRenew?"disable_auto_renew":"enable_auto_renew",`Turn auto-renew ${subscription.autoRenew?"off":"on"} for subscription ${short(subscription.subscriptionId)}`,{subscriptionId:subscription.subscriptionId})}>{subscription.autoRenew?"Turn auto-renew off":"Turn auto-renew on"}</button>
                    <button type="button" className="myso-secondary myso-danger" disabled={locked||!approval.ownerMatches} onClick={()=>{if(window.confirm("Cancel this subscription? Access ends and the subscription object is removed on chain."))run("cancel",`Cancel subscription ${short(subscription.subscriptionId)}`,{subscriptionId:subscription.subscriptionId});}}>Cancel subscription</button>
                </div>
                {open&&<div className="myso-subscription-renew">{!renewing.quote?<p className="myso-loading" role="status">Reading the current renewal terms…</p>:<>
                    <p className="myso-knowledge-note">Renewal keeps your original tier and platform. Current price: <strong>{formatCoin(renewing.quote.terms.priceBaseUnits,renewing.quote.terms.coinType)}</strong> for {formatDuration(renewing.quote.terms.durationMs)}.</p>
                    <CoinPicker id={`renew-coin-${subscription.subscriptionId}`} coins={renewing.coins} needed={BigInt(renewing.quote.terms.priceBaseUnits)} coinType={renewing.quote.terms.coinType} value={renewing.coinId} disabled={locked} onChange={value=>setRenewing(current=>current?{...current,coinId:value}:current)}/>
                    <button type="button" className="myso-primary" disabled={locked||!renewing.coinId||!approval.ownerMatches} onClick={()=>run("renew",`Renew subscription ${short(subscription.subscriptionId)} for ${formatCoin(renewing.quote!.terms.priceBaseUnits,renewing.quote!.terms.coinType)}`,{subscriptionId:subscription.subscriptionId,paymentCoinId:renewing.coinId})}>Review and sign<ArrowRight size={16}/></button>
                </>}</div>}
            </article>;})}</div>}
        <h3>Subscribe to a plan</h3>
        <form className="myso-subscription-find" onSubmit={findPlans}>
            <label htmlFor="subscription-service">Service ID</label>
            <div className="myso-toolbar"><input id="subscription-service" required pattern="0x[0-9a-fA-F]{1,64}" maxLength={66} autoComplete="off" spellCheck={false} placeholder="0x…" value={serviceId} disabled={locked} onChange={event=>{setServiceId(event.target.value);setPlans(null);setPlanId("");setQuote(null);}}/><button className="myso-secondary" disabled={locked||!serviceId.trim()}>{loading==="plans"?"Finding plans…":"Find plans"}</button></div>
        </form>
        {plans&&(plans.length===0?<p className="myso-knowledge-note">This service has no plans.</p>:<fieldset className="myso-subscription-plans"><legend>Choose a plan</legend>{plans.map(plan=><label key={plan.terms.planId} className={plan.active?"":"myso-plan-inactive"}><input type="radio" name="subscription-plan" checked={planId===plan.terms.planId} disabled={locked||!plan.active} onChange={()=>void choosePlan(plan.terms.planId)}/><span><strong>{planTitle(plan)}</strong><small>{formatCoin(plan.terms.priceBaseUnits,plan.terms.coinType)} per {formatDuration(plan.terms.durationMs)}{plan.active?"":" · closed to new subscribers"}</small>{plan.planMetadata?.description?.text&&<small>{plan.planMetadata.description.text}</small>}</span></label>)}</fieldset>)}
        {loading==="quote"&&<p className="myso-loading" role="status">Reading the exact plan terms…</p>}
        {quote&&<div className="myso-subscription-quote">
            <dl className="myso-knowledge-terms"><div><dt>Plan</dt><dd>{planTitle(quote)}</dd></div><div><dt>Price</dt><dd>{formatCoin(quote.terms.priceBaseUnits,quote.terms.coinType)} per {formatDuration(quote.terms.durationMs)}</dd></div><div><dt>Creator</dt><dd>{quote.terms.expectedProfileOwner}</dd></div></dl>
            {!quoteReady?<p className="myso-knowledge-note" role="alert">{!quote.deploymentEnabled?"Subscription purchases are not enabled on this deployment.":"This plan is not currently open for new subscribers."}</p>:<>
                <label className="myso-unlimited-choice"><input type="checkbox" checked={autoRenew} disabled={locked} onChange={event=>{setAutoRenew(event.target.checked);if(!event.target.checked)setPeriods(1);setCoinId("");}}/> Auto-renew at the end of each period</label>
                <label htmlFor="subscription-periods">Periods to pay now</label>
                <input id="subscription-periods" type="number" min={1} max={autoRenew?maxPeriods:1} step={1} value={periods} disabled={locked||!autoRenew} onChange={event=>{const value=Math.floor(Number(event.target.value));setPeriods(Number.isFinite(value)?Math.max(1,Math.min(value,maxPeriods)):1);setCoinId("");}}/>
                <small className="myso-field-hint">{autoRenew?`Up to ${maxPeriods}. Extra periods are held as a prepaid renewal balance.`:"Turn on auto-renew to prepay more than one period."}</small>
                <p className="myso-subscription-total">Total now: <strong>{formatCoin(total.toString(),quote.terms.coinType)}</strong></p>
                <CoinPicker id="subscription-coin" coins={coins} needed={total} coinType={quote.terms.coinType} value={coinId} disabled={locked} onChange={setCoinId}/>
                <button type="button" className="myso-primary" disabled={locked||!coinId||!approval.ownerMatches} onClick={()=>run("subscribe",`Subscribe to ${planTitle(quote)} · ${formatCoin(total.toString(),quote.terms.coinType)} now${autoRenew?" · auto-renew on":""}`,{serviceId:serviceId.trim(),planId,paymentCoinId:coinId,autoRenew,renewalPeriods:String(periods-1)})}>Review and sign<ArrowRight size={16}/></button>
            </>}
        </div>}
        {error&&<p className="myso-knowledge-note" role="alert">{error}</p>}
        {approval.flowPanel}
    </section>;
}
