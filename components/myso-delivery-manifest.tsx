"use client";
import { Download } from "lucide-react";

export interface DeliveryManifestFile {originalName:string;contentLength:number;mediaType:string;sha256Hex:string}
/** A downloaded, digest-checked task artifact, held in memory until the buyer saves it. */
export type DeliveryCheck=
    |{taskId:string;bytes:Uint8Array;kind:"package";files:DeliveryManifestFile[]}
    |{taskId:string;bytes:Uint8Array;kind:"package-failed";reason:string}
    |{taskId:string;bytes:Uint8Array;kind:"single"};

export function formatBytes(length:number):string{
    if(length<1024)return `${length} B`;
    if(length<1024*1024)return `${(length/1024).toFixed(1)} KB`;
    return `${(length/1024/1024).toFixed(1)} MB`;
}
function save(check:DeliveryCheck,suffix:string){
    const zip=check.kind!=="single";
    const url=URL.createObjectURL(new Blob([check.bytes.slice()],{type:zip?"application/zip":"application/octet-stream"}));
    const anchor=document.createElement("a");anchor.href=url;anchor.download=`task-${check.taskId.slice(0,18)}-deliverable${suffix}.${zip?"zip":"bin"}`;anchor.click();
    window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/** Step 2 of buyer delivery: show what was verified, then offer the save.
 *  A package that fails its manifest check is never shown as a file list. */
export function MySoDeliveryManifest({check,onClose}:{check:DeliveryCheck;onClose:()=>void}){
    return <div className="myso-delivery-check" role="region" aria-label="Verified delivery">
        {check.kind==="package"?<>
            <p className="myso-delivery-check-title"><strong>{check.files.length} file{check.files.length===1?"":"s"} · manifest verified</strong><small>Each file’s size and SHA-256 match the package manifest, and the package matches the finalized delivery digest.</small></p>
            <ul className="myso-delivery-files">{check.files.map(file=><li key={file.sha256Hex+file.originalName}><span><strong>{file.originalName}</strong><small>{file.mediaType}</small></span><span className="myso-delivery-size">{formatBytes(file.contentLength)}</span><code title={file.sha256Hex}>sha256 {file.sha256Hex.slice(0,12)}…</code></li>)}</ul>
            <div className="myso-toolbar"><button type="button" className="myso-secondary" onClick={()=>save(check,"")}><Download size={15}/>Download ZIP</button><button type="button" className="myso-text-button" onClick={onClose}>Close</button></div>
        </>:check.kind==="package-failed"?<>
            <p className="myso-delivery-check-title" role="alert"><strong>Manifest check failed</strong><small>{check.reason} The bytes still match the finalized delivery digest, so you can save them to inspect or attach as dispute evidence. Don’t treat their contents as verified.</small></p>
            <div className="myso-toolbar"><button type="button" className="myso-secondary" onClick={()=>save(check,"-unverified")}><Download size={15}/>Download unverified bytes</button><button type="button" className="myso-text-button" onClick={onClose}>Close</button></div>
        </>:<>
            <p className="myso-delivery-check-title"><strong>Single file · {formatBytes(check.bytes.byteLength)}</strong><small>This delivery is not a multi-file package. Its bytes match the finalized delivery digest.</small></p>
            <div className="myso-toolbar"><button type="button" className="myso-secondary" onClick={()=>save(check,"")}><Download size={15}/>Download file</button><button type="button" className="myso-text-button" onClick={onClose}>Close</button></div>
        </>}
    </div>;
}
