const CHANNEL_NAME = "myso-agents:mydata-disclosure:v1";
const LOCAL_EVENT = "myso-agents:mydata-graph-revoked";

export type MyDataGraphRevocation = {
	type: "graph-revoked";
	mydataId: string;
	ownerAddress: string;
	agentAddress: string;
	network: string;
};

function validRevocation(value: unknown): value is MyDataGraphRevocation {
	if (!value || typeof value !== "object") return false;
	const row = value as Record<string, unknown>;
	return row.type === "graph-revoked"
		&& typeof row.mydataId === "string" && /^0x[0-9a-f]{1,64}$/i.test(row.mydataId)
		&& typeof row.ownerAddress === "string" && /^0x[0-9a-f]{1,64}$/i.test(row.ownerAddress)
		&& typeof row.agentAddress === "string" && /^0x[0-9a-f]{1,64}$/i.test(row.agentAddress)
		&& typeof row.network === "string" && /^[a-z0-9_-]{1,32}$/i.test(row.network);
}

/** Drop this app's saved copies of one revoked listing. Bytes already sent outside the app stay where they were sent. */
export function purgeHeldListingCopies(mydataId: string): void {
	if (typeof window === "undefined" || !/^0x[0-9a-f]{1,64}$/i.test(mydataId)) return;
	const needle = mydataId.replace(/^0x/i, "").toLowerCase();
	for (const store of [window.sessionStorage, window.localStorage]) {
		const keys: string[] = [];
		for (let index = 0; index < store.length; index += 1) {
			const key = store.key(index);
			if (!key || !key.startsWith("myso-agents:")) continue;
			const value = store.getItem(key) ?? "";
			if (value.toLowerCase().includes(needle)) keys.push(key);
		}
		for (const key of keys) store.removeItem(key);
	}
}

/** Clear matching active disclosure views in this tab and other MySo Agents tabs. */
export function notifyMyDataGraphRevoked(event: Omit<MyDataGraphRevocation, "type">): void {
	if (typeof window === "undefined") return;
	const message: MyDataGraphRevocation = { type: "graph-revoked", ...event };
	if (!validRevocation(message)) return;
	window.dispatchEvent(new CustomEvent<MyDataGraphRevocation>(LOCAL_EVENT, { detail: message }));
	if (typeof BroadcastChannel !== "undefined") {
		const channel = new BroadcastChannel(CHANNEL_NAME);
		channel.postMessage(message);
		channel.close();
	}
}

export function subscribeToMyDataGraphRevocation(
	listener: (event: MyDataGraphRevocation) => void,
): () => void {
	if (typeof window === "undefined") return () => {};
	const receive = (value: unknown) => {
		if (validRevocation(value)) listener(value);
	};
	const onLocal = (event: Event) => receive((event as CustomEvent<unknown>).detail);
	window.addEventListener(LOCAL_EVENT, onLocal);
	let channel: BroadcastChannel | undefined;
	if (typeof BroadcastChannel !== "undefined") {
		channel = new BroadcastChannel(CHANNEL_NAME);
		channel.addEventListener("message", event => receive(event.data));
	}
	return () => {
		window.removeEventListener(LOCAL_EVENT, onLocal);
		channel?.close();
	};
}
