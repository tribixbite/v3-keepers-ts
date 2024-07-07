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
  MARGIN_ACCOUNT_DISCRIMINATOR,
  MarginAccount,
  PARCL_V3_PROGRAM_ID,
  Position,
  ProgramAccount,
} from "@parcl-oss/v3-sdk";
import {
  // marginAccountSerializer,
  positionSerializer,
} from "@parcl-oss/v3-sdk/dist/cjs/types/accounts/serializers";
import {
  Serializer,
  publicKey as publicKeySerializer,
  u8,
  u32,
  u64,
  // u128,
  // i128,
  struct,
  array,
  bytes,
} from "@metaplex-foundation/umi/serializers";
import { decode, encode } from "bs58";
// import { Connection } from "@solana/web3.js";
const discriminatorFilter = {
  memcmp: {
    offset: 0, // Offset for the discriminator
    bytes: new Uint8Array(MARGIN_ACCOUNT_DISCRIMINATOR),
  },
};

const positionFilters = [];
const positionCount = 12; // Total number of positions
const positionSize = 40; // Size of each position in bytes

for (let i = 0; i < positionCount; i++) {
  positionFilters.push({
    memcmp: {
      offset: 8 + i * positionSize, // Offset for the size field of each position
      bytes: new Uint8Array([
        0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      ]), // Check if size is non-zero
      // bytes: "00000000000000000000000000000000", // Check if size is non-zero
    },
  });
}
const filters = [
  discriminatorFilter,

  // ...positionFilters,
  // {
  //   memcmp: {
  //     offset: 488, // Offset for the margin field
  //     bytes: Uint8Array.from(new Array(32).fill(0)), //"0000000000000000", // Check for non-zero margin
  //   },
  // },
];
// const hasZeroInFirstPosition = accounts.filter(
//   (account) => account.account.positions[0].size === BigInt(0)
// ); //661
// const hasZeroMargin = accounts.filter((account) => account.account.margin === BigInt(0)); //0

export function filterPositioned(accounts: ProgramAccount<MarginAccount>[]) {
  return accounts.filter((account) =>
    account.account.positions.some((position) => position.size !== BigInt(0))
  );
}
export function filterMargined(accounts: ProgramAccount<MarginAccount>[]) {
  return accounts.filter((account) => account.account.margin !== BigInt(0));
}
export async function getPositionedMarginAccounts(rpcUrl: string) {
  // measure how much data is transmitted from the external site:

  const allAccounts = await getAccountClone(rpcUrl, filters);
  const filteredAccounts = filterMargined(allAccounts);
  return filterPositioned(filteredAccounts);
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

async function getAccountClone(rpcUrl: string, filters: RpcDataFilterMemcmp[]): Promise<ProgramAccount<MarginAccount>[]> {
  const umi = createUmi(rpcUrl);
  const startTime = Date.now();
  const rawAccounts = await getProgramAccountsAndRemoveDiscriminators(filters, umi);
  const endTime = Date.now();
  // const dataSize = rawAccounts.reduce((total, account) => total + account.data.length, 0);

  console.log(`getProgramAccountsAndRemoveDiscriminators in ${endTime - startTime} ms`);

  const converted = rawAccounts.map((rawAccount) => ({
    address: rawAccount.publicKey,
    account: deserializeAccount(rawAccount, marginAccountSerializer), //Serializer<MarginAccount>),
  }));
  const ta = converted[11];
  const stringifiedAccountData = {
    address: ta.address.toString(),
    account: {
      positions: ta.account.positions.map((position) => ({
        marketId: position.marketId.toString(),
        size: position.size.toString(),
      })),
      delegate: ta.account.delegate.toString(),
      exchange: ta.account.exchange.toString(),
      owner: ta.account.owner.toString(),
      margin: ta.account.margin.toString(),
      maxLiquidationFee: ta.account.maxLiquidationFee.toString(),
    },
  };
  console.log("stringifiedAccountData: ", JSON.stringify(stringifiedAccountData, null, 2));
  return converted;
}

async function getProgramAccountsAndRemoveDiscriminators(
  filters: RpcDataFilter[],
  umi: Umi
): Promise<RpcAccount[]> {
  const rawAccounts = await umi.rpc.getProgramAccounts(publicKey(PARCL_V3_PROGRAM_ID), {
    filters: [
      ...filters,
      {
        dataSize: 904, // Filter for accounts of size 608 bytes
      },
    ],
  });

  const rawAccountsNoDisc = [];
  for (const rawAccount of rawAccounts) {
    rawAccount.data.copyWithin(0, 8);
    rawAccountsNoDisc.push(rawAccount);
  }
  console.log(encode(rawAccountsNoDisc[11].data));
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

export async function getMarginSlices(rpcUrl: string) {
  const umi = createUmi(rpcUrl);
  const start = Date.now();
  const rawAccounts = await umi.rpc.getProgramAccounts(publicKey(PARCL_V3_PROGRAM_ID), {
    dataSlice: { offset: 96, length: 8 },
    filters: [
      ...filters,
      {
        dataSize: 904, // Filter for accounts of size 608 bytes
      },
    ],
  });
  const end = Date.now();
  console.log(`got ${rawAccounts.length} slices in ${end - start} ms`);

  const margin = rawAccounts
    .filter((account) => {
      const mm = mmSerializer.deserialize(account.data)[0];
      return mm.margin !== BigInt(0);
    })
    .map((account) => {
      console.log(account.publicKey.toString());
      const deser = u64().deserialize(account.data)[0];
      return deser;
    });
  console.log({ margin: margin.length });

  // console.log("marginAccounts", marginAccounts.length);
  return rawAccounts;
}

if ((process.env.DEBUG as string) === "true") {
  const start = Date.now();
  getPositionedMarginAccounts(
    process.env.HELIUS_URL as string
    // filters
  ).then(
    (accounts) => {
      const end = Date.now();
      console.log(`Retrieved ${accounts.length} margin accounts in ${end - start} ms
      `);
    },
    (error) => {
      console.error("Error fetching margin accounts:", error);
    }
  );
  // const start2 = Date.now();
  // getMarginSlices(
  //   // rpc[3],
  //   process.env.HELIUS_URL as string
  //   // filters
  // ).then(
  //   (accounts) => {
  //     const end2 = Date.now();
  //     console.log(`Retrieved ${accounts.length} margin accounts in ${end2 - start2} ms
  //     `);
  //   },
  //   (error) => {
  //     console.error("Error fetching margin accounts:", error);
  //   }
  // );
}

const data = decode("hi");
// read every 32 bytes of the uint8array data and print the output of bs58 encoding the 32 bytes
// const data2 = new Uint8Array(data);
// data has
// let found = false;
//   let offset = 0;
// while (!found) {
const dediscrim = data.copyWithin(0, 8);
for (let i = 8; i < dediscrim.length; i++) {
  // for (let i = 28; i < data.length; i += 32) {
  if (
    u8().deserialize(dediscrim.slice(i, i + 8))[0] === 255
    // encode(data.slice(i)).includes("Cbr4mBZcHRNbMsZnnG9T2evZHudhcP4CmGGbmGjKjDj8")
  ) {
    // "82dGS7Jt4Km8ZgwZVRsJ2V6vPXEhVdgDaMP7cqPGG1TW") {
    console.log(i + ": " + encode(dediscrim.slice(i, i + 32)));
    // found = true;
  }
}
//   offset++;
// }
// console.log(u64().deserialize(data.slice(i, i + 8)));
// console.log(data);
export function filterNonZeroMargins(accounts: RpcAccount[]) {
  console.log(`starting with: ${accounts.length} accounts`);
  return accounts.filter((account) => {
    const margin = u64().deserialize(account.data);
    // u64.deserialize(account.data); // Read the margin value
    return margin[0] !== BigInt(0);
  });
}
// Exchange: {
//   _padding: Uint8Array;
//   accounting: ExchangeAccounting;
//   admin: UmiPublicKey;
//   authorizedProtocolFeesCollector: UmiPublicKey;
//   authorizedSettler: UmiPublicKey;
//   bump: number;
//   collateralExpo: number;
//   collateralMint: UmiPublicKey;
//   collateralVault: UmiPublicKey;
//   id: bigint;
//   idSeed: Uint8Array;
//   marketIds: number[];
//   nominatedAdmin: UmiPublicKey;
//   oracleConfigs: ExchangeOracleConfig[];
//   settings: ExchangeSettings;
//   status: number;
// }
// MarginAccount: {
//   _padding: Uint8Array;
//   bump: number;
//   delegate: UmiPublicKey;
//   exchange: UmiPublicKey;
//   id: number;
//   inLiquidation: number;
//   margin: bigint;
//   maxLiquidationFee: bigint;
//   owner: UmiPublicKey;
//   positions: Position[];
// }
