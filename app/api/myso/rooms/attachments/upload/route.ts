import { handleMySoRoomAttachment } from "@/src/server/myso-work-api";

export const runtime="nodejs";
export const POST=(request:Request)=>handleMySoRoomAttachment(request,"upload");
