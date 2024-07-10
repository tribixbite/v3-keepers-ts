import { publicKey } from "@metaplex-foundation/umi";
import {
  Address,
  ExchangeWrapper,
  LiquidateAccounts,
  LiquidateParams,
  MarginAccountWrapper,
  MarginsWrapper,
  Market,
  MarketMap,
  MarketWrapper,
  ParclV3Sdk,
  PriceFeedMap,
  ProgramAccount,
  getExchangePda,
  getMarketPda,
  translateAddress,
} from "@parcl-oss/v3-sdk";
import {
  Commitment,
  Keypair
} from "@solana/web3.js";
import { decode, encode } from "bs58";
import * as dotenv from "dotenv";
import { getActiveMarginAccounts, getMarginAddressesFromSlice } from "./getActiveMarginAccounts";
import { sendAndConfirmTransactionOptimized } from "./landTransaction";

dotenv.config();
const privateKeyString = process.env.PRIVATE_KEY;
const exchangeLUT = "D36r7C1FeBUARN7f6mkzdX67UJ1b1nUJKC7SWBpDNWsa";
const rpcUrl = process.env.RPC_URL; // Use your preferred RPC URL
const liquidatorAddress = process.env.LIQUIDATOR_MARGIN_ACCOUNT;

(async function main() {
  console.log("Starting liquidator");
  if (!rpcUrl) throw new Error("Missing RPC_URL");
  if (!liquidatorAddress) throw new Error("Missing LIQUIDATOR_MARGIN_ACCOUNT");
  if (!privateKeyString) throw new Error("Missing PRIVATE_KEY");

  // Note: only handling single exchange
  const [exchangeAddress] = getExchangePda(0);
  const liquidatorMarginAccount = translateAddress(liquidatorAddress);
  const liquidatorSigner = Keypair.fromSecretKey(decode(privateKeyString));
  const interval = parseInt(process.env.INTERVAL ?? "300");
  const commitment = (process.env.COMMITMENT ?? "confirmed") as Commitment;

  await runLiquidator({
    rpcUrl,
    commitment,
    interval,
    exchangeAddress,
    liquidatorSigner,
    liquidatorMarginAccount,
  });
})();

type RunLiquidatorParams = {
  rpcUrl: string;
  commitment: Commitment;
  interval: number;
  exchangeAddress: Address;
  liquidatorSigner: Keypair;
  liquidatorMarginAccount: Address;
};

async function runLiquidator({
  rpcUrl,
  commitment,
  interval,
  exchangeAddress,
  liquidatorSigner,
  liquidatorMarginAccount,
  
}: RunLiquidatorParams): Promise<void> {
  let firstRun = true;
  // let marginAccountAddressStore: Address[] = [];
  const sdk = new ParclV3Sdk({ rpcUrl, commitment });
  // const connection = new Connection(rpcUrl, commitment);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (!firstRun) await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const exchange = await sdk.accountFetcher.getExchange(exchangeAddress);
    if (!exchange) throw new Error("Invalid exchange address");

    const marketIdsToFetch = exchange.marketIds.filter((marketId) => marketId !== 0);
    const allMarketAddresses = marketIdsToFetch.map(
      (marketId) => getMarketPda(exchangeAddress, marketId)[0]
    );
    if (firstRun) console.log({ allMarketAddresses: allMarketAddresses.map((a) => a.toBase58()) });

    const allMarkets = await sdk.accountFetcher.getMarkets(allMarketAddresses);
    const [markets, priceFeeds] = await getMarketMapAndPriceFeedMap(sdk, allMarkets);
    if (firstRun) console.log(`Fetched ${Object.keys(markets).length} market and price feeds`);

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

    const activeMarginAccounts = await getActiveMarginAccounts(rpcUrl, addressSlices);

    let checkCount = 0;
    const totalToCount = activeMarginAccounts.length;
    for (const rawMarginAccount of activeMarginAccounts) {
      // TODO: extract top 100 at risk accounts by calling getLiquidationProximity, pass in to next loop
      checkCount++;
      const marginAccount = new MarginAccountWrapper(
        rawMarginAccount.account,
        rawMarginAccount.address
      );
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
          encode(liquidatorSigner.secretKey),
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
          encode(liquidatorSigner.secretKey),
        );
        console.log("Signature: ", signature);
      }
      if (checkCount === totalToCount) {
        console.log(`Checked ${totalToCount} at ${new Date().toISOString()}`);
      }
    }
  }
}

export function getLiquidationProximity(wrapper: MarginsWrapper) {
  return wrapper.margins.requiredMaintenanceMargin
    .add(wrapper.margins.requiredLiquidationFeeMargin)
    .div(wrapper.margins.availableMargin).val;
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

async function liquidate(
  sdk: ParclV3Sdk,
  marginAccount: MarginAccountWrapper,
  accounts: LiquidateAccounts,
  markets: MarketMap,
  privateKeyString: string,
  params?: LiquidateParams
): Promise<string> {
  const [marketAddresses, priceFeedAddresses] = getMarketsAndPriceFeeds(marginAccount, markets);
// const fromKeypair = Keypair.fromSecretKey(decode(privateKeyString));
  const tx = sdk
    .transactionBuilder()
    .liquidate(accounts, marketAddresses, priceFeedAddresses, params)
    // alternatively:
    // await helius.rpc.sendSmartTransaction([instructions], [fromKeypair]);
    .buildUnsigned();
  return await sendAndConfirmTransactionOptimized(tx, privateKeyString, [publicKey(exchangeLUT)]);
}
