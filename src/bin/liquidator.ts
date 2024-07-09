import {
  ProgramAccount,
  Market,
  ParclV3Sdk,
  getExchangePda,
  getMarketPda,
  MarginAccountWrapper,
  MarketWrapper,
  ExchangeWrapper,
  LiquidateAccounts,
  LiquidateParams,
  MarketMap,
  PriceFeedMap,
  Address,
  translateAddress,
} from "@parcl-oss/v3-sdk";
import {
  Commitment,
  Connection,
  Keypair,
  PublicKey,
  Signer,
  // sendAndConfirmTransaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import * as dotenv from "dotenv";
import { sendAndConfirmTransactionOptimized } from "./landTransaction";
import { publicKey } from "@metaplex-foundation/umi";

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
  const liquidatorSigner = Keypair.fromSecretKey(bs58.decode(privateKeyString));
  const interval = parseInt(process.env.INTERVAL ?? "300");
  const commitment = process.env.COMMITMENT as Commitment | undefined;
  const sdk = new ParclV3Sdk({ rpcUrl, commitment });
  const connection = new Connection(rpcUrl, commitment);
  await runLiquidator({
    sdk,
    connection,
    interval,
    exchangeAddress,
    liquidatorSigner,
    liquidatorMarginAccount,
  });
})();

type RunLiquidatorParams = {
  sdk: ParclV3Sdk;
  connection: Connection;
  interval: number;
  exchangeAddress: Address;
  liquidatorSigner: Keypair;
  liquidatorMarginAccount: Address;
};

async function runLiquidator({
  sdk,
  connection,
  interval,
  exchangeAddress,
  liquidatorSigner,
  liquidatorMarginAccount,
}: RunLiquidatorParams): Promise<void> {
  let firstRun = true;
  let print = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (firstRun) {
      firstRun = false;
    } else {
      await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    }
    const exchange = await sdk.accountFetcher.getExchange(exchangeAddress);
    if (exchange === undefined) {
      throw new Error("Invalid exchange address");
    }
    const allMarketAddresses: PublicKey[] = [];
    for (const marketId of exchange.marketIds) {
      if (marketId === 0) {
        continue;
      }
      const [market] = getMarketPda(exchangeAddress, marketId);
      allMarketAddresses.push(market);
    }
    if (!print) {
      console.log(`Fetched ${allMarketAddresses.length} markets`);
      console.log({ allMarketAddresses: allMarketAddresses.map((a) => a.toBase58()) });
      print = true;
    }
    const allMarkets = await sdk.accountFetcher.getMarkets(allMarketAddresses);
    const [[markets, priceFeeds], allMarginAccounts] = await Promise.all([
      getMarketMapAndPriceFeedMap(sdk, allMarkets),
      sdk.accountFetcher.getAllMarginAccounts(),
    ]);
    console.log(`Fetched ${allMarginAccounts.length} margin accounts`);

    let checkCount = 0;
    const totalToCount = allMarginAccounts.length;
    for (const rawMarginAccount of allMarginAccounts) {
      checkCount++;
      const marginAccount = new MarginAccountWrapper(
        rawMarginAccount.account,
        rawMarginAccount.address
      );
      if (marginAccount.inLiquidation()) {
        console.log(`Liquidating account already in liquidation (${marginAccount.address})`);
        await liquidate(
          sdk,
          connection,
          marginAccount,
          {
            marginAccount: rawMarginAccount.address,
            exchange: rawMarginAccount.account.exchange,
            owner: rawMarginAccount.account.owner,
            liquidator: liquidatorSigner.publicKey,
            liquidatorMarginAccount,
          },
          markets,
          [liquidatorSigner],
          liquidatorSigner.publicKey
        );
      }
      if (checkCount === totalToCount) {
        // if (checkCount % 1000 === 0) {
        console.log(`Checked ${totalToCount} at ${new Date().toISOString()}`);
      }
      // delete
      //   const reduceToTotalpositionMaintenanceMargin = (acc, position) => {
      //     const market = markets[position.marketId()];
      //     const priceFeed = priceFeeds[market.priceFeed().toBase58()];
      //     const indexPrice = preciseMath_1.PreciseIntWrapper.fromDecimal(priceFeed.aggregate.price, 0);
      //     const { maintenanceMargin: positionMaintenanceMargin, } = market.getPositionRequiredMargins(position.size(), indexPrice, exchange.collateralExpo());
      //     return acc.add(positionMaintenanceMargin);
      // };
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
          connection,
          marginAccount,
          {
            marginAccount: rawMarginAccount.address,
            exchange: rawMarginAccount.account.exchange,
            owner: rawMarginAccount.account.owner,
            liquidator: liquidatorSigner.publicKey,
            liquidatorMarginAccount,
          },
          markets,
          [liquidatorSigner],
          liquidatorSigner.publicKey
        );
        console.log("Signature: ", signature);
      }
    }
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
  connection: Connection,
  marginAccount: MarginAccountWrapper,
  accounts: LiquidateAccounts,
  markets: MarketMap,
  signers: Signer[],
  feePayer: Address,
  params?: LiquidateParams
): Promise<string> {
  const [marketAddresses, priceFeedAddresses] = getMarketsAndPriceFeeds(marginAccount, markets);
  // const { blockhash: recentBlockhash } = await connection.getLatestBlockhash();
  const tx = sdk
    .transactionBuilder()
    .liquidate(accounts, marketAddresses, priceFeedAddresses, params)
    .buildUnsigned();
  // .feePayer(feePayer)
  // .buildSigned(signers, recentBlockhash);
  return await sendAndConfirmTransactionOptimized(tx, privateKeyString, [publicKey(exchangeLUT)]);
}
