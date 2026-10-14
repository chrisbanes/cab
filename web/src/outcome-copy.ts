/** The receipt fields behind an outcome, shown only in its collapsed Details. */
export interface ReceiptDetails {
  command?: string | undefined;
  resource?: string | undefined;
  version?: number | undefined;
  requestKey?: string | undefined;
  kind?: string | undefined;
  code?: string | undefined;
}

/**
 * Why the service refused a request, in plain words for "Couldn't <do it>: <cause>."
 * The code itself belongs in Details, never in the message.
 */
export function failureCause(code: string): string {
  switch (code) {
    case "forbidden":
    case "insufficient-scope":
      return "you don't have permission";
    case "not-found":
      return "it no longer exists";
    case "conflict":
      return "it changed elsewhere";
    case "body-too-large":
      return "it is too large";
    case "unavailable":
      return "the service is unavailable";
    case "credential-invalid":
      return "the credential isn't valid";
    default:
      return "the service didn't accept it";
  }
}
