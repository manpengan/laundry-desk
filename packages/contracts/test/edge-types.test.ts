import { expectTypeOf, it } from "vitest";

import {
  parseDeviceSignatureExecutionReceiptCandidate,
  parseServerSignatureCapabilityTicketCandidate,
  parseServerSignaturePrimaryLeaseCandidate,
  type DeviceSignatureExecutionReceiptCandidate,
  type ServerSignatureCapabilityTicketCandidate,
  type ServerSignaturePrimaryLeaseCandidate,
} from "../src/index.js";

it("makes server and device signature lines non-interchangeable", () => {
  expectTypeOf<DeviceSignatureExecutionReceiptCandidate>().not.toMatchTypeOf<ServerSignatureCapabilityTicketCandidate>();
  expectTypeOf<ServerSignatureCapabilityTicketCandidate>().not.toMatchTypeOf<DeviceSignatureExecutionReceiptCandidate>();
  expectTypeOf<ServerSignaturePrimaryLeaseCandidate>().not.toMatchTypeOf<ServerSignatureCapabilityTicketCandidate>();

  if (Math.random() < 0) {
    const capability = parseServerSignatureCapabilityTicketCandidate({});
    const receipt = parseDeviceSignatureExecutionReceiptCandidate({});
    const lease = parseServerSignaturePrimaryLeaseCandidate({});
    // @ts-expect-error A device-signed receipt cannot enter a server-signature verification path.
    const wrongServerLine: ServerSignatureCapabilityTicketCandidate = receipt;
    // @ts-expect-error A server-signed capability cannot enter a device-signature verification path.
    const wrongDeviceLine: DeviceSignatureExecutionReceiptCandidate = capability;
    // @ts-expect-error Server-signed objects retain their protocol-object identity.
    const wrongServerObject: ServerSignatureCapabilityTicketCandidate = lease;
    expectTypeOf(wrongServerLine).toMatchTypeOf<ServerSignatureCapabilityTicketCandidate>();
    expectTypeOf(wrongDeviceLine).toMatchTypeOf<DeviceSignatureExecutionReceiptCandidate>();
    expectTypeOf(wrongServerObject).toMatchTypeOf<ServerSignatureCapabilityTicketCandidate>();
  }
});
