import type { Commitment } from "@metaplex-foundation/umi";
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
  Serializer,
  array,
  bytes,
  publicKey as publicKeySerializer,
  struct,
  u32,
  u64,
  u8,
} from "@metaplex-foundation/umi/serializers";
import {
  Address,
  Exchange,
  ExchangeWrapper,
  LiquidateAccounts,
  LiquidateParams,
  MARGIN_ACCOUNT_DISCRIMINATOR,
  MarginAccount,
  MarginAccountWrapper,
  MarginsWrapper,
  MarketMap,
  PARCL_V3_PROGRAM_ID,
  ParclV3Sdk,
  Position,
  PriceFeedMap,
  ProgramAccount,
} from "@parcl-oss/v3-sdk";
import { positionSerializer } from "@parcl-oss/v3-sdk/dist/cjs/types/accounts/serializers";
import { Keypair } from "@solana/web3.js";
import { decode, encode } from "bs58";
import Decimal from "decimal.js";
import { sendAndConfirmTransactionOptimized } from "./landTransaction";

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
const exchangeLUT = "D36r7C1FeBUARN7f6mkzdX67UJ1b1nUJKC7SWBpDNWsa";

export type HighRiskStore = {
  address: Address;
  score: number;
};
export type Liquidator = {
  liquidatorMarginAccount: string;
  privateKeyString: string;
};
export async function checkAddresses(
  rpcUrl: string,
  addresses: Address[],
  // highRiskStore: HighRiskStore[],
  liquidator: Liquidator,
  marketData: {
    exchange: Exchange;
    dataMaps: [MarketMap, PriceFeedMap];
  },
  tryLiquidate?: Address
) {
  const commitment: Commitment = "confirmed";
  const sdk = new ParclV3Sdk({ rpcUrl, commitment });
  const { exchange, dataMaps } = marketData;
  const [markets, priceFeeds] = dataMaps;
  const { liquidatorMarginAccount, privateKeyString } = liquidator;
  const lookupLimit = process.env.LOOKUP_LIMIT;
  const liquidatorSigner = Keypair.fromSecretKey(decode(privateKeyString));

  const threshhold = parseInt(process.env.THRESHHOLD ?? "75");

  const limit = lookupLimit ? parseInt(lookupLimit) : undefined;
  const addressesToGet = addresses.slice(0, limit);

  const activeMarginAccounts = await getActiveMarginAccounts(rpcUrl, addressesToGet);

  let checkCount = 0;
  const totalToCount = activeMarginAccounts.length;
  const highRiskStore: HighRiskStore[] = [];
  for (const rawMarginAccount of activeMarginAccounts) {
    // TODO: extract top 100 at risk accounts by calling getLiquidationProximity, pass in to next loop
    checkCount++;
    const marginAccount = new MarginAccountWrapper(
      rawMarginAccount.account,
      rawMarginAccount.address
    );
    if (tryLiquidate && marginAccount.address === tryLiquidate) {
      console.log(`Attempting to liquidate ${marginAccount.address}`);
      await liquidate(
        sdk,
        marginAccount,
        {
          marginAccount: rawMarginAccount.address,
          exchange: rawMarginAccount.account.exchange,
          owner: rawMarginAccount.account.owner,
          liquidator: liquidatorSigner.publicKey,
          liquidatorMarginAccount,
        },
        markets,
        encode(liquidatorSigner.secretKey)
      );
    }
    if (marginAccount.inLiquidation()) {
      console.log(`Liquidating account already in liquidation (${marginAccount.address})`);
      await liquidate(
        sdk,
        marginAccount,
        {
          marginAccount: rawMarginAccount.address,
          exchange: rawMarginAccount.account.exchange,
          owner: rawMarginAccount.account.owner,
          liquidator: liquidatorSigner.publicKey,
          liquidatorMarginAccount,
        },
        markets,
        encode(liquidatorSigner.secretKey)
      );
    }
    const margins = marginAccount.getAccountMargins(
      new ExchangeWrapper(exchange),
      markets,
      priceFeeds,
      Math.floor(Date.now() / 1000)
    );
    if (margins.canLiquidate()) {
      console.log(`Starting liquidation for ${marginAccount.address}`);
      const signature = await liquidate(
        sdk,
        marginAccount,
        {
          marginAccount: rawMarginAccount.address,
          exchange: rawMarginAccount.account.exchange,
          owner: rawMarginAccount.account.owner,
          liquidator: liquidatorSigner.publicKey,
          liquidatorMarginAccount,
        },
        markets,
        encode(liquidatorSigner.secretKey)
      );
      console.log("Signature: ", signature);
    }
    const liquidationProximity = calculateLiquidationProximityScore(margins);
    if (
      liquidationProximity > threshhold
      // && !highRiskStore.find((a) => a.address === rawMarginAccount.address)
    ) {
      highRiskStore.push({
        address: rawMarginAccount.address,
        score: liquidationProximity,
      });
    }

    if (checkCount === totalToCount) {
      console.log(`Checked ${totalToCount} at ${new Date().toISOString()}`);
    }
  }
  return highRiskStore;
}

function calculateLiquidationProximityScore(margins: MarginsWrapper): number {
  const totalRequired = margins.totalRequiredMargin().val.toPrecision(9);
  //  val: 1276751502711168.411,
  const available = margins.margins.availableMargin.val.toPrecision(9);
  // available: PreciseIntWrapper {
  //   val: 26592083132837317.469,
  if (parseInt(totalRequired) === 0) return 0;
  // Calculate ratio using Decimal to maintain precision
  const ratio = new Decimal(totalRequired).div(new Decimal(available));

  const score = Decimal.max(
    Decimal.min(ratio.valueOf(), new Decimal(1).valueOf()),
    new Decimal(0).valueOf()
  )
    .times(100)
    .toNumber()
    .toPrecision(4);
  return parseInt(score);
}

export async function getActiveMarginAccounts(rpcUrl: string, addresses: Address[]) {
  const start = performance.now();
  const sdk = new ParclV3Sdk({ rpcUrl, commitment: "confirmed" });
  const marginAccounts = await sdk.accountFetcher.getMarginAccounts(addresses);
  const nonZeroAccounts = marginAccounts
    .filter(isDefined<ProgramAccount<MarginAccount>>)
    .filter((a) => a.account.margin !== BigInt(0));
  // nonZeroAccounts.forEach((a) => {
  //   if (a.account.owner.toString() === "DoZ1tbFkx663Pt8RUuw5jzCeypUKQsehXsfuezmmeXrt") {
  //     console.log(stringifiedMarginAccountData(a));
  //   }
  // });
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
  dataSize: 904, // Filter for accounts size in bytes
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

async function liquidate(
  sdk: ParclV3Sdk,
  marginAccount: MarginAccountWrapper,
  accounts: LiquidateAccounts,
  markets: MarketMap,
  privateKeyString: string,
  params: LiquidateParams = {
    isFullLiquidation: false,
  }
): Promise<string> {
  const [marketAddresses, priceFeedAddresses] = getMarketsAndPriceFeeds(marginAccount, markets);
  const liquidatorSigner = Keypair.fromSecretKey(decode(privateKeyString));

  // const fromKeypair = Keypair.fromSecretKey(decode(privateKeyString));
  // const connection = new Connection(process.env.RPC_URL as string, "confirmed");
  // const { blockhash: recentBlockhash } = await connection.getLatestBlockhash();
  const tx = sdk
    .transactionBuilder()
    .liquidate(accounts, marketAddresses, priceFeedAddresses, params)
    .feePayer(liquidatorSigner.publicKey)
    //   .buildSigned([liquidatorSigner], recentBlockhash);
    // return await sendAndConfirmTransaction(connection, tx, [liquidatorSigner])
    // .then((signature) => {
    //   console.log(`Liquidation signature: ${signature}`);
    //   return signature;
    // })
    // .catch((e) => {
    //   if (e instanceof SendTransactionError) {
    //     const logs = e.getLogs(connection);
    //     console.error(`Error logs: ${logs}`);
    //   }
    //   console.error(`Error liquidating: ${e}`);
    //   return e;
    // });
    // alternatively:
    // await helius.rpc.sendSmartTransaction([instructions], [fromKeypair]);
    .buildUnsigned();
  return await sendAndConfirmTransactionOptimized(tx, privateKeyString, [publicKey(exchangeLUT)]);
}

function getMarketsAndPriceFeeds(
  marginAccount: MarginAccountWrapper,
  markets: MarketMap
): [Address[], Address[]] {
  const marketAddresses: Address[] = [];
  const priceFeedAddresses: Address[] = [];
  for (const position of marginAccount.positions()) {
    const market = markets[position.marketId()];
    if (market.address === undefined) {
      throw new Error(`Market is missing from markets map (id=${position.marketId()})`);
    }
    marketAddresses.push(market.address);
    priceFeedAddresses.push(market.priceFeed());
  }
  return [marketAddresses, priceFeedAddresses];
}
