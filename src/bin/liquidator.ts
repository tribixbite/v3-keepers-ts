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
// import { getPositionedMarginAccounts } from "./getActiveMarginAccounts";
dotenv.config();
const privateKeyString = process.env.PRIVATE_KEY as string;
const exchangeLUT = "D36r7C1FeBUARN7f6mkzdX67UJ1b1nUJKC7SWBpDNWsa";
// const rpcUrl = process.env.RPC_URL as string; // Use your preferred RPC URL

(async function main() {
  console.log("Starting liquidator");
  if (process.env.RPC_URL === undefined) {
    throw new Error("Missing rpc url");
  }
  if (process.env.LIQUIDATOR_MARGIN_ACCOUNT === undefined) {
    throw new Error("Missing liquidator margin account");
  }
  if (process.env.PRIVATE_KEY === undefined) {
    throw new Error("Missing liquidator signer");
  }
  // Note: only handling single exchange
  const [exchangeAddress] = getExchangePda(0);
  const liquidatorMarginAccount = translateAddress(process.env.LIQUIDATOR_MARGIN_ACCOUNT);
  const liquidatorSigner = Keypair.fromSecretKey(bs58.decode(privateKeyString));
  const interval = parseInt(process.env.INTERVAL ?? "300");
  const commitment = process.env.COMMITMENT as Commitment | undefined;
  const sdk = new ParclV3Sdk({ rpcUrl: process.env.RPC_URL, commitment });
  const connection = new Connection(process.env.RPC_URL, commitment);
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
    const positionAccounts = allMarginAccounts.filter((a) =>
      a.account.positions.some((p) => p.size > BigInt(0))
    );
    const positionAccountsNeg = allMarginAccounts.filter((a) =>
      a.account.positions.some((p) => p.size < BigInt(0))
    );

    const onlyNegativeDeduped = positionAccountsNeg.filter(
      (a) => !positionAccounts.some((a2) => a2.address.toString() === a.address.toString())
    );
    const onlyPositive = positionAccounts.filter(
      (a) => !positionAccountsNeg.some((a2) => a2.address.toString() === a.address.toString())
    );
    const sumOfPositionsIsNegative = allMarginAccounts.filter(
      (a) =>
        a.account.positions.reduce((acc, position) => acc + BigInt(position.size), BigInt(0)) <
        BigInt(0)
    );
    // const combined = onlyNegativeDeduped.concat(onlyPositive);
    // const sumIsNegative = combined.filter(
    //   (a.reduce
    //     (acc, position) => acc.add(position.size), BigInt(0)
    //   ) < BigInt(0)
    // );
    // positionAccountsNeg.reduce(
    //   (acc, a) => acc + a.account.positions.reduce((acc2, p) => acc2 + p.size, BigInt(0)),
    //   BigInt(0)
    // );
    const nonZeroAccounts = allMarginAccounts.filter((a) => a.account.margin > BigInt(0));
    console.log({
      sumOfPositionsIsNegative: sumOfPositionsIsNegative.length,
      positionAccountsNeg: positionAccountsNeg.length,
      onlyNegativeDeduped: onlyNegativeDeduped.length,
      onlyPositive: onlyPositive.length,
      nonZeroAccounts: nonZeroAccounts.length,
      // combined: combined.length,
    });
    console.log(
      positionAccounts[
        Math.floor(Math.random() * positionAccounts.length)
      ].account.margin.toString()
    );
    console.log(nonZeroAccounts?.[0].account?.margin?.toString());
    // console.log(allMarginAccounts.filter(
    //   (a) => a.address.toString() === (nonZeroAccounts[0].address.toString() || positionAccounts[0].address.toString())
    // )[0].account)

    let checkCount = 0;
    const totalToCount = sumOfPositionsIsNegative.length;
    for (const rawMarginAccount of sumOfPositionsIsNegative) {
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
