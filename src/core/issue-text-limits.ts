/** The limits GitHub-bound issue text is held to everywhere: delivery, the operator contract and drafting. */
export const issueTitleLimit = 512;
export const issueBodyLimit = 64_000;
/** The most GitHub holds in an issue body; the text an edit replaces may be longer than the replacement may be. */
export const issueCurrentBodyLimit = 65_536;
