import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export interface StackFilePin {
  path: string;
  sha256: string;
}
/** Per-run immutable source pins; changed inode/content metadata invalidates a previously checked file. */
export class StackPinnedFiles {
  private readonly verified = new Map<
    string,
    { fingerprint: string; sha256: string }
  >();
  async verify(
    pin: StackFilePin,
    current: () => void,
    maxBytes = 536870912,
  ): Promise<void> {
    current();
    const info = await lstat(pin.path, { bigint: true });
    current();
    if (!info.isFile() || info.isSymbolicLink() || info.size > BigInt(maxBytes))
      throw Error("v2-file-pin-kind-or-size");
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.mode}`;
    const prior = this.verified.get(pin.path);
    if (prior) {
      if (prior.fingerprint !== fingerprint || prior.sha256 !== pin.sha256)
        throw Error("v2-source-pin-changed");
      return;
    }
    const file = await open(
      pin.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const opened = await file.stat({ bigint: true });
      if (
        opened.dev !== info.dev ||
        opened.ino !== info.ino ||
        opened.size !== info.size
      )
        throw Error("v2-file-pin-race");
      const hash = createHash("sha256");
      let bytes = 0n;
      for await (const chunk of file.createReadStream({
        autoClose: false,
        highWaterMark: 65536,
      })) {
        current();
        bytes += BigInt(chunk.byteLength);
        if (bytes > info.size || bytes > BigInt(maxBytes))
          throw Error("v2-file-pin-size-changed");
        hash.update(chunk);
      }
      const ended = await file.stat({ bigint: true });
      if (
        bytes !== info.size ||
        ended.mtimeNs !== info.mtimeNs ||
        ended.ctimeNs !== info.ctimeNs ||
        hash.digest("hex") !== pin.sha256
      )
        throw Error("v2-source-pin");
      current();
      this.verified.set(pin.path, { fingerprint, sha256: pin.sha256 });
    } finally {
      await file.close();
    }
  }
}
