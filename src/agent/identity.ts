import packageMetadata from "../../package.json" with { type: "json" };
/** Product identity, shared without importing provider catalogs or legacy desktop bridges. */
export const APP_IDENTITY = Object.freeze({
    userAgent: Object.freeze({ custom: `myso-agents/${packageMetadata.version}` }),
    attribution: packageMetadata.homepage ? Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }) : null,
});
