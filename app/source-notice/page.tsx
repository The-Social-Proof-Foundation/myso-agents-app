export const dynamic = "force-dynamic";
export default function SourceNotice() {
    const source = process.env.MYSO_AGENTS_SOURCE_URL;
    let validSource: string | undefined;
    try { if (source) { const url = new URL(source); if (url.protocol === "https:" && !url.username && !url.password) validSource = url.toString(); } } catch {}
    return <main className="myso-welcome"><p className="myso-eyebrow">SOURCE &amp; LICENSES</p><h1>MySo Agents</h1><p>This application is a modified fork of LearnHarness by Amos Blomqvist, licensed under GNU AGPL version 3 only. Copyright and license notices remain with their respective authors.</p><p>{validSource?<a href={validSource}>Get this deployment’s corresponding source</a>:"The operator has not configured this deployment’s corresponding-source link. Configure it before public hosting or distribution."}</p><p><a href="/licenses/AGPL-3.0.txt">Application license</a> · <a href="/fonts/OFL-chakrapetch.txt">Chakra Petch license</a> · <a href="/fonts/OFL-spacegrotesk.txt">Space Grotesk license</a></p><p>MySocial names, logos and icons are brand assets. Their inclusion does not grant trademark rights. Network services and SDKs retain their separate licenses.</p><p><a href="https://github.com/amosblomqvist/learnharness">Original LearnHarness source</a> · <a href="/">Back to your work</a></p></main>;
}
