import {
  RpcAccount,
  RpcDataFilter,
  RpcDataFilterMemcmp,
  Umi,
  deserializeAccount,
  publicKey,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
import {
  Address,
  MARGIN_ACCOUNT_DISCRIMINATOR,
  MarginAccount,
  PARCL_V3_PROGRAM_ID,
  ParclV3Sdk,
  Position,
  ProgramAccount,
} from "@parcl-oss/v3-sdk";
import { positionSerializer } from "@parcl-oss/v3-sdk/dist/cjs/types/accounts/serializers";
import {
  Serializer,
  publicKey as publicKeySerializer,
  u8,
  u32,
  u64,
  struct,
  array,
  bytes,
} from "@metaplex-foundation/umi/serializers";
import { decode } from "bs58";

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export async function getActiveMarginAccounts(rpcUrl: string, addresses: Address[]) {
  const start = performance.now();
  const sdk = new ParclV3Sdk({ rpcUrl, commitment: "confirmed" });
  const marginAccounts = await sdk.accountFetcher.getMarginAccounts(addresses);
  const nonZeroAccounts = marginAccounts
    .filter(isDefined<ProgramAccount<MarginAccount>>)
    .filter((a) => a.account.margin !== BigInt(0));
  const end = performance.now();
  console.log(`Found ${nonZeroAccounts.length} non-zero margin accounts in ${end - start} ms`);
  // console.log(stringifiedMarginAccountData(nonZeroAccounts[0]));
  return nonZeroAccounts;
}

const discriminatorFilter = {
  memcmp: {
    offset: 0, // Offset for the discriminator
    bytes: new Uint8Array(MARGIN_ACCOUNT_DISCRIMINATOR),
  },
};
const marginAccountFilter = {
  dataSize: 904, // Filter for accounts of size 608 bytes
};
const filters = [discriminatorFilter];

export function filterPositioned(accounts: ProgramAccount<MarginAccount>[]) {
  return accounts.filter((account) =>
    account.account.positions.some((position) => position.size !== BigInt(0))
  );
}
export function filterMargined(accounts: ProgramAccount<MarginAccount>[]) {
  return accounts.filter((account) => account.account.margin !== BigInt(0));
}

const marginAccountSerializer: Serializer<MarginAccount> = struct([
  ["positions", array(positionSerializer, { size: 12 })],
  ["margin", u64()],
  ["maxLiquidationFee", u64()],
  ["id", u32()],
  ["exchange", publicKeySerializer()],
  ["owner", publicKeySerializer()],
  ["delegate", publicKeySerializer()],
  ["inLiquidation", u8()],
  ["bump", u8()],
  ["_padding", bytes({ size: 10 })],
]);
type MarginMargin = {
  margin: bigint;
};
const mmSerializer: Serializer<MarginMargin> = struct([["margin", u64()]]);

async function getProgramAccountsAndRemoveDiscriminators(
  filters: RpcDataFilter[] = [discriminatorFilter],
  umi: Umi
): Promise<RpcAccount[]> {
  const rawAccounts = await umi.rpc.getProgramAccounts(publicKey(PARCL_V3_PROGRAM_ID), {
    filters: [...filters, marginAccountFilter],
  });

  const rawAccountsNoDisc = [];
  for (const rawAccount of rawAccounts) {
    rawAccount.data.copyWithin(0, 8);
    rawAccountsNoDisc.push(rawAccount);
  }
  return rawAccountsNoDisc;
}

export type MarginAccountPositionsOnly = {
  positions: Position[];
};
export const MarginAccountPositionsOnlySerializer: Serializer<MarginAccountPositionsOnly> = struct([
  ["positions", array(positionSerializer, { size: 12 })],
]);

export const test = {
  hasZeroMargin: 0,
  hasZeroInFirstPosition: 661,
};
// filters: RpcDataFilterMemcmp[]

export async function getMarginAddressesFromSlice(rpcUrl: string) {
  const umi = createUmi(rpcUrl);
  const start = performance.now();
  const rawAccounts = await umi.rpc.getProgramAccounts(publicKey(PARCL_V3_PROGRAM_ID), {
    dataSlice: { offset: 776, length: 8 },
    filters: [...filters, marginAccountFilter],
  });
  const end = performance.now();
  console.log(`Fetched ${rawAccounts.length} slices in ${end - start} ms`);
  // measure and print how long this takes:

  const marginedAccountAddresses = rawAccounts
    .filter((account) => {
      return deserializeMargin(account.data) !== BigInt(0);
    })
    .map((rawAccount) => rawAccount.publicKey);
  // console.log("marginAccounts", marginAccounts.length);
  return marginedAccountAddresses as Address[];
}

export const exampleMarginAccount = decode(
  "1111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111115UBz9xkCbCAG9EXkHyKRM8L56X8DDDATAqzKVQsHDmEwLLsDqCGZZACbhZyxu1EK4sA1JvHSn6mgvsjeXBgoz1Lq9KozXSHBxAVENvyXdj2XC4S5aaAG8xTryqnoZK9eDjNoBcu1FkW7iuDuDs2sfKxbNM4gKh62H683Hc3LS87WFJQvHL6Yg7LMhh"
);

export const deserializeMargin = (data: Uint8Array, offset: number = 0) => {
  return mmSerializer.deserialize(data.slice(offset, offset + 8))[0].margin;
};

export function findOffset(
  dataBuffer: Uint8Array,
  dataLength: number = 0,
  deserializeFn: (data: Uint8Array) => bigint | string,
  findMatch: string | bigint
) {
  // console.log(encode(dataBuffer.slice(820, 852))); //owner EK1wdQLoPKy9DtPWUFVpFwt9bdszoQ6qjxA7aCR7trZz
  for (let i = 0; i < dataBuffer.length - dataLength; i++) {
    if (deserializeFn(dataBuffer.slice(i, i + dataLength)) === findMatch) {
      console.log(`match at ${i} bytes`); // or 788?
    }
  }
}

export function filterNonZeroMargins(accounts: RpcAccount[]) {
  console.log(`starting with: ${accounts.length} accounts`);
  return accounts.filter((account) => {
    const margin = u64().deserialize(account.data);
    return margin[0] !== BigInt(0);
  });
}

export async function getPositionedMarginAccounts(rpcUrl: string) {
  const allAccounts = await getAccountClone(rpcUrl, filters);
  const filteredAccounts = filterMargined(allAccounts);
  return filterPositioned(filteredAccounts);
}
async function getAccountClone(
  rpcUrl: string,
  filters: RpcDataFilterMemcmp[] = [discriminatorFilter]
): Promise<ProgramAccount<MarginAccount>[]> {
  const umi = createUmi(rpcUrl);
  const startTime = performance.now();
  const rawAccounts = await getProgramAccountsAndRemoveDiscriminators(filters, umi);
  const endTime = performance.now();

  console.log(`getProgramAccountsAndRemoveDiscriminators in ${endTime - startTime} ms`);
  const converted = rawAccounts.map((rawAccount) => ({
    address: rawAccount.publicKey,
    account: deserializeAccount(rawAccount, marginAccountSerializer), //Serializer<MarginAccount>),
  }));
  return converted;
}

const positionCount = 12; // Total number of positions
const positionSize = 56; // Size of each position in bytes

export const positionFilters = Array.from({ length: positionCount })
  .map((_, i) => i)
  .map((i) => ({
    memcmp: {
      offset: 8 + i * positionSize, // Offset for the size field of each position
      bytes: new Uint8Array(Array.from({ length: 8 }).fill(0) as number[]), // Filter for non-zero size
    },
  }));

export function stringifiedMarginAccountData(account: ProgramAccount<MarginAccount>) {
  return JSON.stringify(
    {
      address: account.address.toString(),
      account: {
        positions: account.account.positions.map((position) => ({
          marketId: position.marketId.toString(),
          size: position.size.toString(),
        })),
        delegate: account.account.delegate.toString(),
        exchange: account.account.exchange.toString(),
        owner: account.account.owner.toString(),
        margin: account.account.margin.toString(),
        maxLiquidationFee: account.account.maxLiquidationFee.toString(),
      },
    },
    null,
    2
  );
}
