"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, EyeOff, X } from "lucide-react";
import type { MyDataContentPage, MyDataGraphOfferPage, MyDataGraphOfferProof, MyDataListingPage, MyDataQuote } from "@/src/core/contracts/mydata";
import { mySoGraphManifestSchema, type MySoGraphEdge, type MySoGraphEvidence, type MySoGraphItemResult, type MySoGraphNode, type MySoGraphSearchResult } from "@/src/core/contracts/myso-knowledge-graph";
import { MySoGraphPublisher } from "./myso-graph-publisher";
import { MySoGraphPurchase } from "./myso-graph-purchase";
import { MySoKnowledgeCanvas } from "./myso-knowledge-canvas";
import { EMPTY_KNOWLEDGE_GRAPH, KNOWLEDGE_STATE_STYLE, mergeKnowledgeGraph, type KnowledgeCanvasGraph } from "./myso-knowledge-canvas-data";
import { MySoPurchaseHistory } from "./myso-purchase-history";
import { purgeHeldListingCopies, subscribeToMyDataGraphRevocation } from "@/src/core/mydata-disclosure";

function graphItemTitle(result:MySoGraphItemResult){
    if(result.kind==="node")return (result.item as MySoGraphNode).label;
    if(result.kind==="edge"){const item=result.item as MySoGraphEdge;return `${item.sourceId} ${item.kind} ${item.targetId}`;}
    return `${(result.item as MySoGraphEvidence).kind} evidence`;
}
function graphItemDescription(result:MySoGraphItemResult){
    if(result.kind==="node"){const item=result.item as MySoGraphNode;return `${item.statement||"No description"} · Aliases: ${item.aliases.join(" · ")||"None"} · State: ${item.state}`;}
    if(result.kind==="edge"){const item=result.item as MySoGraphEdge;return `State: ${item.state} · Evidence IDs: ${item.evidenceIds.join(" · ")||"None"}`;}
    const item=result.item as MySoGraphEvidence;return `Source: ${item.sourceId} · Version: ${item.sourceVersion} · Visibility: ${item.visibility} · State: ${item.state}`;
}
function graphTermsDescription(terms:MyDataGraphOfferProof["publication"]["offerTerms"]){
    const revocation=terms.revocationPolicy==="one_time_perpetual"?"one-time access to this version is perpetual except for fraud or platform-policy enforcement":terms.revocationPolicy==="subscription_period_end"?"access ends when the paid subscription period ends":"the seller may end future subscription access early; already fetched content cannot be withdrawn";
    const entitlement="this offer covers only the named immutable graph version; future versions require separate offers and purchases";
    return `${revocation}; ${entitlement}.`;
}

/** Request-local disclosure only. No storage, journal, HTML rendering or model dispatch. */
export function MySoKnowledgeReader({organizationId,ownerAddress,agentAddress,network,onRequestGraphPurchase}:{organizationId?:string,ownerAddress?:string,agentAddress?:string,network?:string,onRequestGraphPurchase?:(request:{mydataId:string,graphId:string,graphVersion:number,manifestHashHex:string,publicationSignatureHex:string,audienceKind:"agent"|"organization",organizationAudienceId?:string,priceMist:string,accessKind:2|3,durationDays:string,offerTerms:MyDataGraphOfferProof["publication"]["offerTerms"]})=>void}){
    const [listing,setListing]=useState("");const [quote,setQuote]=useState<MyDataQuote|null>(null);
    const [page,setPage]=useState<MyDataContentPage|null>(null);const [format,setFormat]=useState<"utf8"|"base64">("utf8");
    const [listings,setListings]=useState<MyDataListingPage|MyDataGraphOfferPage|null>(null);
    const [verifiedOffers,setVerifiedOffers]=useState<Record<string,MyDataGraphOfferProof>>({});const [verifyingOffer,setVerifyingOffer]=useState("");
    const [graphQuery,setGraphQuery]=useState("");const [graphResult,setGraphResult]=useState<MySoGraphSearchResult|null>(null);
    const [graphItem,setGraphItem]=useState<MySoGraphItemResult|null>(null);
    const [canvasGraph,setCanvasGraph]=useState<KnowledgeCanvasGraph>(EMPTY_KNOWLEDGE_GRAPH);const [matchIds,setMatchIds]=useState<ReadonlySet<string>|null>(null);const [revokedListings,setRevokedListings]=useState<ReadonlySet<string>>(new Set());const manifestText=useRef("");
    const [audience,setAudience]=useState<"agent"|"organization"|null>(null);
    const [acknowledgedOffers,setAcknowledgedOffers]=useState<Record<string,boolean>>({});
    const audienceRequest=audience==="organization"&&organizationId?{organizationAudienceId:organizationId}:{};
    const [listingMode,setListingMode]=useState<"listings"|"owned-listings"|"graph-offers">("listings");
    const [busy,setBusy]=useState(false);const [error,setError]=useState("");
    const request=useRef<AbortController|null>(null);const generation=useRef(0);
    const clearRevokedListingRef=useRef<(mydataId:string)=>void>(()=>{});
    useEffect(()=>{
        function clear(){generation.current++;request.current?.abort();setPage(null);setGraphResult(null);setGraphItem(null);setCanvasGraph(EMPTY_KNOWLEDGE_GRAPH);setMatchIds(null);setVerifiedOffers({});setError("");setBusy(false);}
        function hidden(){if(document.visibilityState!=="visible")clear();}
        document.addEventListener("visibilitychange",hidden);window.addEventListener("pagehide",clear);
        return()=>{generation.current++;request.current?.abort();document.removeEventListener("visibilitychange",hidden);window.removeEventListener("pagehide",clear);};
    },[]);
    useEffect(()=>subscribeToMyDataGraphRevocation(event=>{
        const normalize=(value:string|undefined)=>value?.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
        if(event.network.toLowerCase()!==network?.toLowerCase()||normalize(event.ownerAddress)!==normalize(ownerAddress)||normalize(event.agentAddress)!==normalize(agentAddress))return;
        clearRevokedListingRef.current(event.mydataId);
    }),[network,ownerAddress,agentAddress]);
    useEffect(()=>{
        generation.current++;request.current?.abort();request.current=null;
        setListing("");setQuote(null);setPage(null);setListings(null);setVerifiedOffers({});setVerifyingOffer("");
        setGraphQuery("");setGraphResult(null);setGraphItem(null);setCanvasGraph(EMPTY_KNOWLEDGE_GRAPH);setMatchIds(null);
        setAudience(null);setAcknowledgedOffers({});setError("");setBusy(false);
    },[organizationId,ownerAddress,network]);
    function offerAcceptanceKey(id:string,proof:MyDataGraphOfferProof){return `${id}:${proof.publication.signatureHex}`;}
    function isOfferAccepted(id:string,proof:MyDataGraphOfferProof){return acknowledgedOffers[offerAcceptanceKey(id,proof)]===true;}
    function acknowledgeOffer(key:string,checked:boolean){setAcknowledgedOffers(current=>({...current,[key]:checked}));}
    function offerAcknowledgement(id:string,proof:MyDataGraphOfferProof){const key=offerAcceptanceKey(id,proof);return <label className="myso-knowledge-note" htmlFor={`graph-terms-${id}`}><input id={`graph-terms-${id}`} type="checkbox" checked={acknowledgedOffers[key]===true} onChange={event=>acknowledgeOffer(key,event.target.checked)}/> I have reviewed and accept these seller terms: {graphTermsDescription(proof.publication.offerTerms)}</label>;}
    function clearContent(){generation.current++;request.current?.abort();setPage(null);setGraphResult(null);setGraphItem(null);setCanvasGraph(EMPTY_KNOWLEDGE_GRAPH);setMatchIds(null);setError("");setBusy(false);}
    function listingKey(value:string){return value.replace(/^0x/i,"").toLowerCase().padStart(64,"0");}
    function clearRevokedListing(mydataId:string){
        const key=listingKey(mydataId);
        setRevokedListings(current=>new Set(current).add(key));
        purgeHeldListingCopies(mydataId);
        void fetch("/api/myso/knowledge/purge-revoked",{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify({mydataId})}).catch(()=>{});
        manifestText.current="";
        if(quote&&listingKey(quote.mydataId)===key){clearContent();setQuote(null);setListing("");setGraphQuery("");setError("This listing was revoked for the current agent. This view will not read it again.");}
    }
    clearRevokedListingRef.current=clearRevokedListing;
    async function call<T>(kind:"listings"|"owned-listings"|"graph-offers"|"quote"|"verify-offer"|"read"|"graph-search"|"graph-item",body:object):Promise<T>{
        request.current?.abort();const controller=new AbortController();request.current=controller;
        const result=await fetch(`/api/myso/knowledge/${kind}`,{method:"POST",cache:"no-store",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),signal:controller.signal});
        const data=await result.json();if(!result.ok)throw new Error(data.error??"This content is unavailable");return data as T;
    }
    async function verifyOffer(id:string){
        setVerifyingOffer(id);setError("");
        try{const proof=await call<MyDataGraphOfferProof>("verify-offer",{mydataId:id});setVerifiedOffers(value=>({...value,[id]:proof}));}
        catch(reason){setError(reason instanceof Error?reason.message:"Unable to verify this graph offer");}
        finally{setVerifyingOffer("");}
    }
    async function inspectId(id=listing.trim()){
        const turn=++generation.current;setBusy(true);setPage(null);setQuote(null);setError("");
        try{const result=await call<MyDataQuote>("quote",{mydataId:id});if(turn===generation.current)setQuote(result);}
        catch(reason){if(turn===generation.current)setError(reason instanceof Error?reason.message:"Unable to inspect this listing");}
        finally{if(turn===generation.current)setBusy(false);}
    }
    async function inspect(event:FormEvent){event.preventDefault();await inspectId();}
    async function browse(offset=0,mode:typeof listingMode=listingMode){
        const turn=++generation.current;setBusy(true);setPage(null);setError("");
        if(offset===0)setVerifiedOffers({});
        try{const result=await call<MyDataListingPage|MyDataGraphOfferPage>(mode,{limit:20,offset});if(turn===generation.current){
            setListings(current=>{
                if(offset===0||!current)return result;
                if("offers" in current&&"offers" in result){
                    const offers=new Map(current.offers.map(item=>[item.mydataId.toLowerCase(),item]));
                    for(const item of result.offers)offers.set(item.mydataId.toLowerCase(),item);
                    return {...result,offers:[...offers.values()],offset:current.offset,scannedCount:current.scannedCount+result.scannedCount};
                }
                if("listings" in current&&"listings" in result){
                    const items=new Map(current.listings.map(item=>[item.mydataId.toLowerCase(),item]));
                    for(const item of result.listings)items.set(item.mydataId.toLowerCase(),item);
                    return {...result,listings:[...items.values()],offset:current.offset,scannedCount:current.scannedCount+result.scannedCount};
                }
                return result;
            });
            setListingMode(mode);
        }}
        catch(reason){if(turn===generation.current)setError(reason instanceof Error?reason.message:"Unable to load MyData listings");}
        finally{if(turn===generation.current)setBusy(false);}
    }
    async function loadAllGraphOfferPages(){
        if(listingMode!=="graph-offers"||!listings||!("offers" in listings)||listings.nextOffset===null)return;
        const turn=++generation.current;setBusy(true);setError("");
        let accumulated:MyDataGraphOfferPage=listings;
        let nextOffset=accumulated.nextOffset;
        const seenOffsets=new Set<number>([accumulated.offset]);
        let pages=0;
        try{
            while(nextOffset!==null){
                if(seenOffsets.has(nextOffset)||nextOffset<=accumulated.offset){
                    throw new Error("The graph offer service repeated a page cursor; discovery stopped to avoid returning an incomplete series.");
                }
                if(pages>=2500){
                    throw new Error("Graph offer discovery reached the service's bounded page limit. The displayed offers are partial.");
                }
                seenOffsets.add(nextOffset);
                const requestedOffset=nextOffset;
                const result=await call<MyDataGraphOfferPage>("graph-offers",{limit:50,offset:requestedOffset});
                if(turn!==generation.current)return;
                if(result.offset!==requestedOffset||result.scannedCount>50||result.nextOffset!==null&&result.nextOffset<=requestedOffset){
                    throw new Error("The graph offer service returned an invalid cursor; discovery stopped.");
                }
                const offers=new Map(accumulated.offers.map(item=>[item.mydataId.toLowerCase(),item]));
                for(const item of result.offers)offers.set(item.mydataId.toLowerCase(),item);
                accumulated={...result,offers:[...offers.values()],offset:listings.offset,scannedCount:accumulated.scannedCount+result.scannedCount};
                nextOffset=result.nextOffset;
                pages++;
                setListings(accumulated);
            }
        }catch(reason){
            if(turn===generation.current&&!((reason instanceof DOMException)&&reason.name==="AbortError")){
                setListings(accumulated);
                setError(reason instanceof Error?reason.message:"Unable to finish graph offer discovery");
            }
        }finally{if(turn===generation.current)setBusy(false);}
    }
    function manifestGraph(text:string){const parsed=mySoGraphManifestSchema.safeParse(JSON.parse(text));return parsed.success?mergeKnowledgeGraph(EMPTY_KNOWLEDGE_GRAPH,parsed.data.entities,parsed.data.relations):null;}
    async function read(offset:number){
        if(!quote||!audience)return;if(revokedListings.has(listingKey(quote.mydataId))){setError("This listing was revoked for the current agent. This view will not read it again.");return;}const turn=++generation.current;setBusy(true);setPage(null);setGraphResult(null);setError("");
        try{const result=await call<MyDataContentPage>("read",{mydataId:quote.mydataId,encryptedDataDigestHex:quote.purchaseParameters.encryptedDataDigestHex,format,offset,limit:4000,...audienceRequest});if(turn===generation.current&&document.visibilityState==="visible"){setPage(result);if(result.format==="utf8"){manifestText.current=offset===0?result.data:manifestText.current+result.data;if(!result.hasNext){try{const graph=manifestGraph(manifestText.current);if(graph){setCanvasGraph(graph);setMatchIds(null);}}catch{manifestText.current="";}}}}}
        catch(reason){if(turn===generation.current)setError(reason instanceof Error?reason.message:"Unable to read this content");}
        finally{if(turn===generation.current)setBusy(false);}
    }
    async function searchGraph(event:FormEvent){
        event.preventDefault();if(!quote||!audience||!graphQuery.trim())return;if(revokedListings.has(listingKey(quote.mydataId))){setError("This listing was revoked for the current agent. This view will not read it again.");return;}const turn=++generation.current;setBusy(true);setPage(null);setGraphResult(null);setGraphItem(null);setMatchIds(null);setError("");
        try{const result=await call<MySoGraphSearchResult>("graph-search",{mydataId:quote.mydataId,encryptedDataDigestHex:quote.purchaseParameters.encryptedDataDigestHex,query:graphQuery.trim(),limit:10,...audienceRequest});if(turn===generation.current&&document.visibilityState==="visible"){setGraphResult(result);setMatchIds(new Set(result.matches.map(match=>match.node.id)));setCanvasGraph(current=>current.nodes.length?current:mergeKnowledgeGraph(EMPTY_KNOWLEDGE_GRAPH,result.matches.map(match=>match.node),result.matches.flatMap(match=>match.edges)));}}
        catch(reason){if(turn===generation.current)setError(reason instanceof Error?reason.message:"Unable to search this private graph");}
        finally{if(turn===generation.current)setBusy(false);}
    }
    async function inspectGraphItem(kind:"node"|"edge"|"evidence",id:string){
        if(!quote||!audience)return;const turn=++generation.current;setBusy(true);setPage(null);setGraphItem(null);setError("");
        try{const result=await call<MySoGraphItemResult>("graph-item",{mydataId:quote.mydataId,encryptedDataDigestHex:quote.purchaseParameters.encryptedDataDigestHex,kind,id,...audienceRequest});if(turn===generation.current&&document.visibilityState==="visible"){setGraphItem(result);setCanvasGraph(current=>mergeKnowledgeGraph(current,result.kind==="node"?[result.item as MySoGraphNode,...result.nodes]:result.nodes,result.edges));}}
        catch(reason){if(turn===generation.current)setError(reason instanceof Error?reason.message:"Unable to read this graph record");}
        finally{if(turn===generation.current)setBusy(false);}
    }
    const listingItems=listings? ("offers" in listings?listings.offers:listings.listings):[];
    return <section className="myso-knowledge" aria-label="Private MyData access" aria-busy={busy}>
        <MySoGraphPublisher organizationId={organizationId} onPublished={()=>void browse(0,"owned-listings")}/>
        <form className="myso-create" onSubmit={inspect}>
            <h2>Private knowledge access</h2><p>Browse public offers or open a MyData listing shared with you. For every graph purchase, choose the agent or organization audience explicitly before purchasing or reading.</p>
            <div className="myso-toolbar"><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void browse(0,"listings")}>Browse paid listings<ArrowRight size={16}/></button><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void browse(0,"graph-offers")}>Browse graph offers<ArrowRight size={16}/></button><button type="button" className="myso-secondary" disabled={busy} onClick={()=>void browse(0,"owned-listings")}>My published listings<ArrowRight size={16}/></button></div>
            <MySoPurchaseHistory disabled={busy} ownerAddress={ownerAddress} agentAddress={agentAddress} network={network} onInspect={id=>{setListing(id);void inspectId(id);}} onAccessRevoked={clearRevokedListing}/>
            {listings&&<div className="myso-listing-results" aria-label="MyData listings">
                {listingMode==="graph-offers"&&<fieldset className="myso-knowledge-audience"><legend>Choose who this graph purchase is for</legend><label><input type="radio" name="knowledge-offer-audience" checked={audience==="agent"} disabled={busy} onChange={()=>{clearContent();setAudience("agent");}}/>This agent</label><label><input type="radio" name="knowledge-offer-audience" checked={audience==="organization"} disabled={busy||!organizationId} onChange={()=>{clearContent();setAudience("organization");}}/>Organization members</label>{audience===null?<small>Choose an audience before requesting an agent purchase or approving a wallet purchase. No audience is selected by default.</small>:audience==="organization"&&organizationId?<small>Organization {organizationId} · access follows current organization permission checks.</small>:<small>This purchase grants access to this connected agent.</small>}</fieldset>}
                {listingItems.length===0?<p className="myso-knowledge-note">{listingMode==="listings"?"No paid listings were found on this page.":listingMode==="graph-offers"?"No graph offers were found on this page.":"No published MyData records were found on this page."}</p>:listingItems.map(item=><article className="myso-listing-card" id={`graph-offer-${item.mydataId}`} key={item.mydataId}>
                    <div><strong>{item.mediaType}</strong><p>{item.tags.length?item.tags.join(" · "):"MyData listing"}</p><small>{item.mydataId}</small></div>
                    <div className="myso-listing-price">{item.oneTimePriceMist!==null?`${item.oneTimePriceMist} MIST · one time`:""}{item.oneTimePriceMist!==null&&item.subscriptionPriceMist!==null?" / ":""}{item.subscriptionPriceMist!==null?`${item.subscriptionPriceMist} MIST · ${item.subscriptionDurationDays} days`:""}</div>
                    {listingMode==="graph-offers"?<button type="button" className="myso-secondary" disabled={busy||verifyingOffer===item.mydataId||!!verifiedOffers[item.mydataId]} onClick={()=>void verifyOffer(item.mydataId)}>{verifiedOffers[item.mydataId]?`Seller proof verified · ${verifiedOffers[item.mydataId]!.manifestHashHex.slice(0,10)}…`:verifyingOffer===item.mydataId?"Checking seller proof…":"Verify seller proof"}</button>:<button type="button" className="myso-secondary" disabled={busy} onClick={()=>{setListing(item.mydataId);clearContent();void inspectId(item.mydataId);}}>Get exact quote</button>}
                    {listingMode==="graph-offers"&&verifiedOffers[item.mydataId]&&<>
                        <p className="myso-knowledge-note">{verifiedOffers[item.mydataId]!.publication.graphId?`Graph ${verifiedOffers[item.mydataId]!.publication.graphId} · immutable version ${verifiedOffers[item.mydataId]!.publication.graphVersion} · manifest ${verifiedOffers[item.mydataId]!.manifestHashHex.slice(0,12)}`:"Legacy offer: graph identity is not in its public proof; only its manifest hash can be verified."} · Current quote and seller signature verified · {verifiedOffers[item.mydataId]!.publication.offerTerms.priceMist} MIST · {verifiedOffers[item.mydataId]!.publication.offerTerms.accessKind===2?"one time":`${verifiedOffers[item.mydataId]!.publication.offerTerms.durationDays} days per subscription`}. The encrypted graph hash and source rights are checked after access is purchased.</p>
                        {verifiedOffers[item.mydataId]!.publication.offerTerms.accessKind===3&&<p className="myso-knowledge-note">This is a fixed-duration purchase for this immutable graph version. The same buyer signer can buy this listing again to extend an active period on-chain; it does not auto-charge or include later graph versions.</p>}
                        {offerAcknowledgement(item.mydataId,verifiedOffers[item.mydataId]!)}
                        {verifiedOffers[item.mydataId]!.publication.graphId&&verifiedOffers[item.mydataId]!.publication.graphVersion&&<button type="button" className="myso-secondary" disabled={busy||!isOfferAccepted(item.mydataId,verifiedOffers[item.mydataId]!)||audience===null||!verifiedOffers[item.mydataId]!.quote.deploymentEnabled||(audience==="organization"&&!organizationId)||!onRequestGraphPurchase} onClick={()=>{const proof=verifiedOffers[item.mydataId]!;const graphId=proof.publication.graphId;const graphVersion=proof.publication.graphVersion;if(!graphId||!graphVersion||!audience||!isOfferAccepted(item.mydataId,proof))return;onRequestGraphPurchase?.({mydataId:item.mydataId,graphId,graphVersion,manifestHashHex:proof.manifestHashHex,publicationSignatureHex:proof.publication.signatureHex,audienceKind:audience,...(audience==="organization"&&organizationId?{organizationAudienceId:organizationId}:{}),priceMist:proof.quote.purchaseParameters.priceMist,accessKind:proof.quote.purchaseParameters.accessKind,durationDays:proof.quote.purchaseParameters.durationDays,offerTerms:proof.publication.offerTerms});}}>{verifiedOffers[item.mydataId]!.publication.offerTerms.accessKind===3?"Ask agent to buy/extend this subscription":"Ask agent to purchase this version"}<ArrowRight size={16}/></button>}
                        {verifiedOffers[item.mydataId]!.publication.graphId&&verifiedOffers[item.mydataId]!.publication.graphVersion&&ownerAddress&&network&&verifiedOffers[item.mydataId]!.quote.deploymentEnabled&&audience&&<MySoGraphPurchase key={`${item.mydataId}:${audience}:${audience==="organization"?organizationId:"agent"}`} proof={{mydataId:item.mydataId,graphId:verifiedOffers[item.mydataId]!.publication.graphId!,graphVersion:verifiedOffers[item.mydataId]!.publication.graphVersion!,manifestHashHex:verifiedOffers[item.mydataId]!.manifestHashHex,publicationSignatureHex:verifiedOffers[item.mydataId]!.publication.signatureHex,priceMist:verifiedOffers[item.mydataId]!.quote.purchaseParameters.priceMist,accessKind:verifiedOffers[item.mydataId]!.quote.purchaseParameters.accessKind,durationDays:verifiedOffers[item.mydataId]!.quote.purchaseParameters.durationDays,offerTerms:verifiedOffers[item.mydataId]!.publication.offerTerms}} acknowledged={isOfferAccepted(item.mydataId,verifiedOffers[item.mydataId]!)} audienceKind={audience} organizationAudienceId={audience==="organization"?organizationId:undefined} ownerAddress={ownerAddress} network={network} onAccessRevoked={clearContent}/>}
                    </>}
                </article>)}
                <div className="myso-pagination"><span>Showing {listingItems.length} unique records across browsed pages{listings.nextOffset===null?" · no next page reported":""}</span>{listingMode==="graph-offers"&&listings.nextOffset!==null&&<button className="myso-secondary" disabled={busy} onClick={()=>void loadAllGraphOfferPages()}>{busy?"Loading graph offer pages…":"Load all graph offer pages"}</button>}<button className="myso-secondary" disabled={busy||listings.nextOffset===null} onClick={()=>listings.nextOffset!==null&&void browse(listings.nextOffset,listingMode)}>Load next page<ArrowRight size={15}/></button></div>
                <p className="myso-knowledge-note">{listingMode==="listings"?"Listings are public indexer previews and can be stale. “Get exact quote” checks current on-chain terms; it does not assess graph quality or content usefulness.":listingMode==="graph-offers"?"Graph offers are metadata-only previews and can be stale. Use Verify seller proof to check the signed manifest commitment and current authority against a live quote before purchase; this does not prove source-rights claims or graph quality.":"Your records are public indexer metadata only. Encrypted content stays behind current MyData access policy."}</p>
            </div>}
            <label htmlFor="knowledge-listing">MyData listing ID</label><input id="knowledge-listing" required pattern="0x[0-9a-fA-F]{1,64}" maxLength={66} autoComplete="off" spellCheck={false} value={listing} onChange={event=>{clearContent();setQuote(null);setListing(event.target.value);}} disabled={busy} placeholder="0x…"/>
            <div className="myso-toolbar"><button className="myso-primary" disabled={busy||!listing.trim()}>{busy?"Checking access…":"Inspect listing"}<ArrowRight size={16}/></button></div>
        </form>
        {error&&<p role="alert" className="myso-error">{error}</p>}
        {quote&&<>
            <dl className="myso-knowledge-terms"><div><dt>Seller</dt><dd>{quote.purchaseParameters.expectedSeller}</dd></div>
                <div><dt>Price</dt><dd>{quote.purchaseParameters.priceMist} MIST</dd></div>
                <div><dt>Access</dt><dd>{quote.purchaseParameters.accessKind===2?"One-time purchase":`${quote.purchaseParameters.durationDays} days per purchase`}</dd></div>
                <div><dt>Agent receiving access</dt><dd>{quote.buyerAddress}</dd></div>
                <div><dt>Listing version</dt><dd>{quote.objectVersion}</dd></div>
                <div><dt>Content fingerprint</dt><dd>{quote.purchaseParameters.encryptedDataDigestHex}</dd></div>
            </dl>
            <p className="myso-knowledge-note">{quote.deploymentEnabled?"Your agent can purchase access from Work when its live on-chain permissions and per-action MYSO limit authorize the purchase.":"Purchasing is not enabled on this deployment."} Reading below checks your current access. A purchase receipt does not confirm that the content is useful or accurate.</p>
            <fieldset className="myso-knowledge-audience"><legend>Purchase and reader audience</legend><label><input type="radio" name="knowledge-audience" checked={audience==="agent"} disabled={busy} onChange={()=>{clearContent();setAudience("agent");}}/>This agent</label><label><input type="radio" name="knowledge-audience" checked={audience==="organization"} disabled={busy||!organizationId} onChange={()=>{clearContent();setAudience("organization");}}/>Organization members</label>{audience===null?<small>Choose the audience for this graph. No audience is selected by default.</small>:audience==="organization"&&organizationId?<small>Organization {organizationId} · access requires the current OrgMemoryReader permission.</small>:!organizationId?<small>This agent is not linked to an organization.</small>:<small>The selected audience is explicit and is never inferred from organization membership.</small>}</fieldset>
            <form className="myso-create" onSubmit={searchGraph}>
                <h3>Search private knowledge graph</h3><p>Search a MySocial typed JSON graph stored in this MyData record. Results remain in this view and are not added to a work run or model context.</p>
                <label htmlFor="knowledge-graph-query">Search terms</label><input id="knowledge-graph-query" maxLength={200} autoComplete="off" value={graphQuery} onChange={event=>setGraphQuery(event.target.value)} disabled={busy} placeholder="People, tasks, claims, rooms…"/>
                <button className="myso-primary" disabled={busy||!graphQuery.trim()||!audience}>{busy?"Searching…":"Search graph"}<ArrowRight size={16}/></button>
            </form>
            {graphResult&&<section className="myso-knowledge-graph" aria-label="Opened private graph">
                <div className="myso-room-history-heading"><div><p className="myso-eyebrow">PRIVATE GRAPH · {graphResult.matches.length} MATCH{graphResult.matches.length===1?"":"ES"}</p><h3>“{graphResult.query}”</h3></div><button type="button" className="myso-icon-button" aria-label="Close graph" onClick={clearContent}><X size={18}/></button></div>
                {graphResult.verifiedPublication&&<p className="myso-knowledge-note" role="status">Seller signature, immutable graph hash and current selling authority verified against the quoted MyData terms. Seller: {graphResult.verifiedPublication.sellerAddress} · manifest {graphResult.verifiedPublication.manifestHashHex.slice(0,16)}… · published {new Date(graphResult.verifiedPublication.publishedAtMs).toLocaleString()}. Evidence labels do not independently prove upstream source truth.</p>}
                {graphResult.matches.length===0?<p className="myso-knowledge-note">No matching graph nodes were found. Try other search terms.</p>:<div className="myso-knowledge-graph-body">
                    <MySoKnowledgeCanvas graph={canvasGraph} highlight={matchIds} selectedId={graphItem?.kind==="node"?graphItem.item.id:null} onSelect={id=>{if(!busy)void inspectGraphItem("node",id);}}/>
                    <aside className="myso-knowledge-graph-panel" aria-label={graphItem?"Selected record":"Search matches"}>
                        {graphItem?<section className="myso-graph-item" aria-label="Private graph record details"><button type="button" className="myso-text-button" onClick={()=>setGraphItem(null)}><ArrowLeft size={14}/>Matches</button><p className="myso-eyebrow">{graphItem.kind.toUpperCase()} · {graphItem.graphId} v{graphItem.graphVersion}</p><h3>{graphItemTitle(graphItem)}</h3>{graphItem.kind==="node"&&<p className="myso-knowledge-state"><span className={`myso-state-dot myso-state-${(graphItem.item as MySoGraphNode).state}`} aria-hidden="true"/>{KNOWLEDGE_STATE_STYLE[(graphItem.item as MySoGraphNode).state].label} · {(graphItem.item as MySoGraphNode).kind}</p>}{graphItem.verifiedPublication&&<p className="myso-knowledge-note" role="status">Seller signature, immutable graph hash and current selling authority verified against the quoted MyData terms · manifest {graphItem.verifiedPublication.manifestHashHex.slice(0,16)}…</p>}<p className="myso-knowledge-note">{graphItemDescription(graphItem)}</p><div className="myso-graph-neighborhood"><div><strong>Related records</strong>{graphItem.nodes.length?graphItem.nodes.map(item=><button type="button" className="myso-knowledge-match" key={item.id} disabled={busy} onClick={()=>void inspectGraphItem("node",item.id)}><span className={`myso-state-dot myso-state-${item.state}`} aria-hidden="true"/><span>{item.label}<small>{item.kind} · {item.state}</small></span></button>):<p>None</p>}</div><div><strong>Related connections</strong>{graphItem.edges.length?graphItem.edges.map(item=><p key={item.id}>{graphItem.nodes.find(node=>node.id===item.sourceId)?.label??item.sourceId} → {item.kind} → {graphItem.nodes.find(node=>node.id===item.targetId)?.label??item.targetId} · {item.state}</p>):<p>None</p>}</div><div><strong>Related evidence</strong>{graphItem.evidence.length?graphItem.evidence.map(item=><p key={item.id}>{item.kind} · {item.sourceId} · {item.state}</p>):<p>None</p>}</div></div>{graphItem.provenance.length>0&&<p className="myso-knowledge-note">Provenance: {graphItem.provenance.map(item=>`${item.actor} · ${item.subjectType} · ${item.state} · ${new Date(item.recordedAt).toLocaleString()}`).join("; ")}</p>}</section>
                        :<><p className="myso-eyebrow">MATCHES</p><p className="myso-knowledge-note">Select a record here or on the graph to see its details and related records.</p>{graphResult.matches.map(match=><button type="button" className="myso-knowledge-match" key={match.node.id} disabled={busy} onClick={()=>void inspectGraphItem("node",match.node.id)}><span className={`myso-state-dot myso-state-${match.node.state}`} aria-hidden="true"/><span>{match.node.label}<small>{match.node.kind} · {match.node.state}{match.edges.length>0?` · ${match.edges.length} connection${match.edges.length===1?"":"s"}`:""}</small></span></button>)}</>}
                    </aside>
                </div>}
                <p className="myso-knowledge-note">{graphResult.evidenceNotice} The graph layout stays in this view and is cleared when you close it or leave.</p>
            </section>}
            <div className="myso-toolbar myso-knowledge-controls"><label htmlFor="knowledge-format">Read as</label><select id="knowledge-format" value={format} disabled={busy} onChange={event=>{clearContent();setFormat(event.target.value as "utf8"|"base64");}}><option value="utf8">Text</option><option value="base64">Binary · base64</option></select>
                <button className="myso-primary" disabled={busy||!audience} onClick={()=>void read(0)}>Read with current access<ArrowRight size={16}/></button>
                {page&&<button className="myso-secondary" onClick={clearContent}><EyeOff size={16}/>Hide content</button>}
            </div>
            <p className="myso-knowledge-note">Displayed temporarily in this view. This reader does not add content to a work conversation or send it to an AI model. Leaving or hiding the window clears the displayed page.</p>
        </>}
        {page&&<div className="myso-knowledge-page"><div className="myso-status">Access checked for this page · {page.format==="utf8"?"Text":"Base64"}</div>
            <pre aria-label="Authorized private content">{page.data||"Empty content"}</pre>
            <div className="myso-pagination"><button className="myso-secondary" disabled={busy||page.offset===0} onClick={()=>void read(Math.max(0,page.offset-4000))}><ArrowLeft size={15}/>Previous</button><span>{page.total===0?"0":`${page.offset+1}–${page.nextOffset??page.total}`} of {page.total} {page.offsetUnit==="byte"?"bytes":"characters"}</span><button className="myso-secondary" disabled={busy||page.nextOffset===null} onClick={()=>page.nextOffset!==null&&void read(page.nextOffset)}>Next<ArrowRight size={15}/></button></div>
        </div>}
    </section>;
}
