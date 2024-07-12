import { publicKey } from "@metaplex-foundation/umi";
import {
  Address,
  Market,
  MarketMap,
  MarketWrapper,
  ParclV3Sdk,
  PriceFeedMap,
  ProgramAccount,
  getExchangePda,
  getMarketPda,
} from "@parcl-oss/v3-sdk";
import { Commitment } from "@solana/web3.js";
// import { decode } from "bs58";
import * as dotenv from "dotenv";
import {
  HighRiskStore,
  Liquidator,
  checkAddresses,
  getMarginAddressesFromSlice,
} from "@utils/getActiveMarginAccounts";

dotenv.config();
const privateKeyString = process.env.PRIVATE_KEY;
const rpcUrl = process.env.RPC_URL; // Use your preferred RPC URL
const liquidatorAddress = process.env.LIQUIDATOR_MARGIN_ACCOUNT;
const instantCheck = parseInt(process.env.INSTANT_CHECK_QUANTITY ?? "50");
(async function main() {
  console.log("Starting liquidator");
  if (!rpcUrl) throw new Error("Missing RPC_URL");
  if (!liquidatorAddress) throw new Error("Missing LIQUIDATOR_MARGIN_ACCOUNT");
  if (!privateKeyString) throw new Error("Missing PRIVATE_KEY");

  // Note: only handling single exchange
  const [exchangeAddress] = getExchangePda(0);
  const liquidator: Liquidator = {
    liquidatorMarginAccount: publicKey(liquidatorAddress),
    privateKeyString,
  };
  const interval = parseInt(process.env.INTERVAL ?? "300");
  const commitment = (process.env.COMMITMENT ?? "confirmed") as Commitment;

  await runLiquidator({
    rpcUrl,
    commitment,
    interval,
    exchangeAddress,
    liquidator,
  });
})();

type RunLiquidatorParams = {
  rpcUrl: string;
  commitment: Commitment;
  interval: number;
  exchangeAddress: Address;
  liquidator: Liquidator;
};

async function runLiquidator({
  rpcUrl,
  commitment,
  interval,
  exchangeAddress,
  liquidator,
}: RunLiquidatorParams): Promise<void> {
  let firstRun = true;
  // let marginAccountAddressStore: Address[] = [];

  const highRiskStore: HighRiskStore[] = [];
  const sdk = new ParclV3Sdk({ rpcUrl, commitment });
  const exchange = await sdk.accountFetcher.getExchange(exchangeAddress);
  if (!exchange) throw new Error("Invalid exchange address");
  // const connection = new Connection(rpcUrl, commitment);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!firstRun) await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const marketIdsToFetch = exchange.marketIds.filter((marketId) => marketId !== 0);
    const allMarketAddresses = marketIdsToFetch.map(
      (marketId) => getMarketPda(exchangeAddress, marketId)[0]
    );
    if (firstRun) console.log({ allMarketAddresses: allMarketAddresses.map((a) => a.toBase58()) });

    const allMarkets = await sdk.accountFetcher.getMarkets(allMarketAddresses);
    const dataMaps = await getMarketMapAndPriceFeedMap(sdk, allMarkets);
    const marketData = { exchange, dataMaps };
    const [markets] = dataMaps;
    if (firstRun) console.log(`Fetched ${Object.keys(markets).length} market and price feeds`);
    const highRiskScoreSorted = highRiskStore.sort((a, b) => b.score - a.score);
    if (firstRun && highRiskScoreSorted.length > 0 && highRiskScoreSorted[0].score > 98) {
      const highRiskAddresses = highRiskStore.map((a) => a.address);
      await checkAddresses(rpcUrl, highRiskAddresses, liquidator, marketData, highRiskAddresses[0]);
    }
    if (!firstRun) {
      if (highRiskScoreSorted.length < instantCheck)
        console.info(
          "Stored high risk accounts < INSTANT_CHECK_QUANTITY. Try lowering the threshold."
        );
      if (highRiskStore.length === 0) {
        console.log("No high risk accounts in store.");
      } else {
        const slicedHighRisk = highRiskScoreSorted.slice(0, instantCheck);
        console.log(
          `${highRiskStore.length} high risk accounts. Top 10 `,
          highRiskScoreSorted.slice(0, 2)
        );
        const highRiskAddresses = slicedHighRisk.map((a) => a.address);
        await checkAddresses(
          rpcUrl,
          highRiskAddresses,
          liquidator,
          marketData,
          highRiskAddresses[0]
        );
      }
    }
    const addressSlices = await getMarginAddressesFromSlice(rpcUrl);
    // TODO: this should only be done once, then subscribe to onProgramAccountChange with margin account filter
    // TODO: similarly, yellowstone/geyser can be used to subscribe to market + margin account updates

    if (firstRun) {
      // marginAccountAddressStore = addressSlices;
      firstRun = false;
    }
    // this logic may be necessary depending on the exact 'margin' value calc for the edge case of when a positioned account becomes exactly 0
    // const storedMarginAccountNowZero = marginAccountAddressStore.filter(
    //   (address) => !addressSlices.includes(address)
    // );
    // marginAccountAddressStore = addressSlices;
    // const immediateMatch = storedMarginAccountNowZero.length > 0; -> check those directly or add them depending

    // I was unable to access "Source Code URL	https://github.com/ParclFinance/parcl-v3"
    const highRisk = await checkAddresses(rpcUrl, addressSlices, liquidator, marketData);
    //replace stored high risk store with new one
    highRiskStore.length = 0;
    highRiskStore.push(...highRisk);
  }
}

async function getMarketMapAndPriceFeedMap(
  sdk: ParclV3Sdk,
  allMarkets: (ProgramAccount<Market> | undefined)[]
): Promise<[MarketMap, PriceFeedMap]> {
  const markets: MarketMap = {};
  for (const market of allMarkets) {
    if (market === undefined) {
      continue;
    }
    markets[market.account.id] = new MarketWrapper(market.account, market.address);
  }
  const allPriceFeedAddresses = (allMarkets as ProgramAccount<Market>[]).map(
    (market) => market.account.priceFeed
  );
  const allPriceFeeds = await sdk.accountFetcher.getPythPriceFeeds(allPriceFeedAddresses);
  const priceFeeds: PriceFeedMap = {};
  for (let i = 0; i < allPriceFeeds.length; i++) {
    const priceFeed = allPriceFeeds[i];
    if (priceFeed === undefined) {
      continue;
    }
    priceFeeds[allPriceFeedAddresses[i]] = priceFeed;
  }
  return [markets, priceFeeds];
}
