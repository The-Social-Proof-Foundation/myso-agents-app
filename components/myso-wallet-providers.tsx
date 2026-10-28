"use client";

import { useEffect, useState } from "react";
import { MySoClientProvider, WalletProvider } from "@socialproof/dapp-kit";
import { MySoJsonRpcClient } from "@socialproof/myso/jsonRpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { registerWalletConnectWallet } from "@socialproof/walletconnect-wallet";

const networks = {
    mainnet: { url: "https://fullnode.mainnet.mysocial.network:443", network: "mainnet" as const },
    testnet: { url: "https://fullnode.testnet.mysocial.network:443", network: "testnet" as const },
    devnet: { url: "https://fullnode.devnet.mysocial.network:443", network: "devnet" as const },
    localnet: { url: "http://127.0.0.1:9000", network: "localnet" as const },
};
const queryClient = new QueryClient();
function clientFor(network: keyof typeof networks) { return new MySoJsonRpcClient(networks[network]); }

export function MySoWalletProviders({ children }: { children: React.ReactNode }) {
    const [walletConnectReady, setWalletConnectReady] = useState(false);
    useEffect(() => {
        const projectId = process.env.NEXT_PUBLIC_MYSO_WALLETCONNECT_PROJECT_ID;
        if (!projectId) return;
        const registered = registerWalletConnectWallet({
            projectId,
            getClient: (network) => clientFor(network as keyof typeof networks),
            metadata: { id: "myso-agents", walletName: "MySo Agents", icon: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxIDEiPjwvc3ZnPg==", enabled: true },
        });
        setWalletConnectReady(!!registered);
        return () => { registered?.unregister(); setWalletConnectReady(false); };
    }, []);
    return <QueryClientProvider client={queryClient}><MySoClientProvider networks={networks} defaultNetwork="testnet"><WalletProvider autoConnect storageKey="myso-agents-wallet" preferredWallets={walletConnectReady ? ["WalletConnect"] : []}>{children}</WalletProvider></MySoClientProvider></QueryClientProvider>;
}
