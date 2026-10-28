"use client";
import { useEffect, useRef, useState } from "react";
import type { RoomMemberPage } from "@/src/core";

type Api=<T>(path:string,init?:RequestInit)=>Promise<T>;
interface RoomRemovalResult {groupId:string;digest:string;member:string;keyVersionBefore:string;keyVersionAfter:string;futureAccess:"revoked";pastAccess:"may_remain_available_or_previously_copied";verification:"finalized_membership_and_key_version";source:"myso_fullnode"}
export interface BulkRoom {uuid:string;groupId:string;name:string}
export type BulkRowState={status:"pending"}|{status:"removing"}|{status:"removed";keyVersionAfter:string;digest:string}|{status:"failed";reason:string};

const ROOM_PAGE=200, MAX_ROOM_PAGES=25, MEMBER_PAGE=50, MAX_MEMBER_PAGES=40;
const same=(a:string,b:string|undefined)=>!!b&&a.replace(/^0x/i,"").toLowerCase().padStart(64,"0")===b.replace(/^0x/i,"").toLowerCase().padStart(64,"0");
const isReader=(permissions:string[])=>permissions.some(permission=>permission.endsWith("::MessagingReader"));

/** Pure: does a finalized removal result prove this exact member left this room with a rotated key? */
export function removalVerified(result:RoomRemovalResult,room:BulkRoom,member:string):boolean{
    return same(result.groupId,room.groupId)&&same(result.member,member)&&result.futureAccess==="revoked"&&result.pastAccess==="may_remain_available_or_previously_copied"&&result.verification==="finalized_membership_and_key_version"&&BigInt(result.keyVersionAfter)>BigInt(result.keyVersionBefore);
}
/** Pure: summary line for the per-room run. */
export function bulkSummary(states:Record<string,BulkRowState>):string{
    const values=Object.values(states);const removed=values.filter(value=>value.status==="removed").length;const failed=values.filter(value=>value.status==="failed").length;
    if(values.some(value=>value.status==="removing"||value.status==="pending")&&removed+failed>0)return `Removed from ${removed} of ${values.length} rooms so far…`;
    if(failed===0)return `Removed from all ${removed} room${removed===1?"":"s"}. Each room key was rotated.`;
    return `Removed from ${removed} of ${values.length} rooms. ${failed} room${failed===1?"":"s"} failed and ${failed===1?"is":"are"} listed below; retry each one when ready.`;
}

/** Remove one member from every room the agent can list, one
 *  remove-and-rotate call per room. Failures stay visible; nothing retries on its own. */
export function MySoRoomBulkRemove({member,selfAddress,api,onClose,onDone}:{member:string;selfAddress?:string;api:Api;onClose:()=>void;onDone:()=>void}){
    const [scan,setScan]=useState<{checked:number;rooms:BulkRoom[];done:boolean;error:string}>({checked:0,rooms:[],done:false,error:""});
    const [scanAttempt,setScanAttempt]=useState(0);
    const [acknowledged,setAcknowledged]=useState(false);const [states,setStates]=useState<Record<string,BulkRowState>|null>(null);const [running,setRunning]=useState(false);
    const alive=useRef(true);
    const scanGeneration=useRef(0);
    useEffect(()=>{
        const generation=++scanGeneration.current;
        const currentScan=()=>alive.current&&scanGeneration.current===generation;
        alive.current=true;
        setScan({checked:0,rooms:[],done:false,error:""});
        void (async()=>{
            const found:BulkRoom[]=[];const foundIds=new Set<string>();let checked=0;
            try{
                for(let page=0;page<MAX_ROOM_PAGES;page++){
                    const data=await api<{items:Record<string,unknown>[]}>(`views/rooms?offset=${page*ROOM_PAGE}&limit=${ROOM_PAGE}`);
                    for(const item of data.items){
                        if(!currentScan())return;
                        checked++;setScan(current=>({...current,checked}));
                        if(typeof item.groupId!=="string"||typeof item.groupUuid!=="string")throw new Error("A room entry is missing its verified identifiers; no rooms were changed.");
                        let cursor:string|null=null;let membershipPageComplete=false;
                        for(let memberPage=0;memberPage<MAX_MEMBER_PAGES;memberPage++){
                            const query=new URLSearchParams({limit:String(MEMBER_PAGE)});if(cursor)query.set("cursor",cursor);
                            const members:RoomMemberPage=await api<RoomMemberPage>(`rooms/${encodeURIComponent(item.groupId)}/members?${query}`);
                            if(members.members.some(entry=>same(entry.address,member)&&isReader(entry.permissions))){if(!foundIds.has(item.groupId)){foundIds.add(item.groupId);found.push({uuid:item.groupUuid,groupId:item.groupId,name:typeof item.groupName==="string"&&item.groupName?item.groupName:"Work room"});}membershipPageComplete=true;break;}
                            if(!members.hasNextPage){membershipPageComplete=true;break;}
                            if(!members.nextCursor)throw new Error(`Room ${item.groupId} returned another member page without a continuation cursor; no rooms were changed.`);
                            if(memberPage===MAX_MEMBER_PAGES-1)throw new Error(`Room ${item.groupId} exceeded the member scan limit; no rooms were changed.`);
                            cursor=members.nextCursor;
                        }
                        if(!membershipPageComplete)throw new Error(`Room ${item.groupId} membership could not be completely checked; no rooms were changed.`);
                    }
                    if(data.items.length<ROOM_PAGE)break;
                    if(page===MAX_ROOM_PAGES-1)throw new Error(`Stopped after checking ${checked} rooms. The list below may be incomplete.`);
                }
                if(currentScan())setScan({checked,rooms:found,done:true,error:""});
            }catch(reason){if(currentScan())setScan({checked,rooms:found,done:true,error:reason instanceof Error?reason.message:"Rooms could not be checked"});}
        })();
        return()=>{if(scanGeneration.current===generation)alive.current=false;};
    },[api,member,scanAttempt]);
    async function removeFrom(room:BulkRoom){
        setStates(current=>({...current,[room.groupId]:{status:"removing"}}));
        try{
            const result=await api<RoomRemovalResult>(`rooms/${encodeURIComponent(room.uuid)}/members`,{method:"POST",body:JSON.stringify({action:"remove",member,acknowledgeFutureAccessRemoval:true})});
            if(!removalVerified(result,room,member))throw new Error("The finalized removal or key rotation did not match this room and member.");
            setStates(current=>({...current,[room.groupId]:{status:"removed",keyVersionAfter:result.keyVersionAfter,digest:result.digest}}));
        }catch(reason){setStates(current=>({...current,[room.groupId]:{status:"failed",reason:reason instanceof Error?reason.message:"Removal failed"}}));}
    }
    async function runAll(){
        if(!scan.done||scan.error||!acknowledged||running)return;
        setRunning(true);setStates(Object.fromEntries(scan.rooms.map(room=>[room.groupId,{status:"pending"} as BulkRowState])));
        for(const room of scan.rooms){if(!alive.current)return;await removeFrom(room);}
        if(alive.current){setRunning(false);onDone();}
    }
    async function retry(room:BulkRoom){setRunning(true);await removeFrom(room);if(alive.current){setRunning(false);onDone();}}
    function retryScan(){setStates(null);setAcknowledged(false);setScanAttempt(value=>value+1);}
    const self=same(member,selfAddress);
    return <div className="myso-room-invite myso-room-bulk" role="group" aria-label="Remove member from every room">
        <h4>Remove from every room</h4>
        <p>Remove <code>{member}</code> from every room this agent can list, rotating each room’s encryption key. This revokes access to future messages after each rotation; past messages and plaintext already saved may remain accessible.</p>
        {self?<p role="alert">The connected agent can’t remove itself.</p>:!scan.done?<p className="myso-loading" role="status">Checking rooms… {scan.checked} checked</p>:<>
            {scan.error&&<><p role="alert">{scan.error} The bulk removal is blocked until a complete scan succeeds.</p><button type="button" className="myso-secondary" disabled={running} onClick={retryScan}>Retry complete room scan</button></>}
            {scan.rooms.length===0?<p>This wallet is not a reader in any room the agent can list.</p>:<>
                <p>{states?bulkSummary(states):`Found in ${scan.rooms.length} of ${scan.checked} room${scan.checked===1?"":"s"}:`}</p>
                <ul className="myso-room-bulk-list">{scan.rooms.map(room=>{const state=states?.[room.groupId];return <li key={room.groupId} data-status={state?.status??"ready"}>
                    <span><strong>{room.name}</strong><small>{room.groupId}</small></span>
                    <span className="myso-room-bulk-status" role="status">{!state?"":state.status==="pending"?"Waiting":state.status==="removing"?"Removing and rotating key…":state.status==="removed"?`✓ Removed · key version ${state.keyVersionAfter}`:<>✕ Failed: {state.reason} <button type="button" className="myso-text-button" disabled={running} onClick={()=>void retry(room)}>Retry this room</button></>}</span>
                </li>;})}</ul>
                {!states&&<><label><input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/> I understand past access cannot be recalled in any of these rooms.</label>
                <button type="button" className="myso-secondary myso-danger" disabled={!scan.done||!!scan.error||!acknowledged||running} onClick={()=>void runAll()}>Remove from {scan.rooms.length} room{scan.rooms.length===1?"":"s"} and rotate keys</button></>}
            </>}
        </>}
        <button type="button" className="myso-text-button" disabled={running} onClick={onClose}>{states&&!running?"Close":"Cancel"}</button>
    </div>;
}
