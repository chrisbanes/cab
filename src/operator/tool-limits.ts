/** Caps and literals shared by tool capture, the timeline contract and the web. */
export const maxToolPaths = 25;
export const maxToolPathChars = 256;
/** The longest target a timeline entry shows (127 characters plus an ellipsis when cut). */
export const maxToolTargetChars = 128;
/** A target over this is dropped whole at capture, so no cut text is ever stored. */
export const maxCapturedTargetChars = 512;
/** Stands in for any path that is not inside the assignment's workspace. */
export const outsideWorkspace = "outside workspace";
