import { networkInterfaces } from "node:os";

export function testLanAddress(): string {
  const address = Object.values(networkInterfaces())
    .flat()
    .find(
      (entry) => entry && entry.family === "IPv4" && !entry.internal,
    )?.address;
  if (!address) throw new Error("A non-loopback IPv4 test address is required");
  return address;
}
