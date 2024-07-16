import { checkAddresses } from "@/utils/checkAddresses";
import { fetchMarketData } from "@/utils/fetchMarketData";
import { publicKey } from "@metaplex-foundation/umi";
import {
  Address,
  Exchange,
  MarketMap,
  ParclV3Sdk,
  PriceFeedMap,
  getExchangePda,
} from "@parcl-oss/v3-sdk";
import { Commitment } from "@solana/web3.js";
import { HighRiskStore, Liquidator, getMarginAddressesFromSlice } from "@utils/marginAccounts";
import * as dotenv from "dotenv";

dotenv.config();

const privateKeyString = process.env.PRIVATE_KEY;
const rpcUrl = process.env.RPC_URL; // Use your preferred RPC URL
const liquidatorAddress = process.env.LIQUIDATOR_MARGIN_ACCOUNT;
const instantCheck = parseInt(process.env.INSTANT_CHECK_QUANTITY ?? "50");
const interval = parseInt(process.env.INTERVAL ?? "300");
const commitment = (process.env.COMMITMENT ?? "confirmed") as Commitment;

if (!rpcUrl) throw new Error("Missing RPC_URL");
if (!liquidatorAddress) throw new Error("Missing LIQUIDATOR_MARGIN_ACCOUNT");
if (!privateKeyString) throw new Error("Missing PRIVATE_KEY");
let lastLog = Date.now() - 1000 * 60 * 60;

(async function main() {
  console.log("Starting liquidator");

  // Note: only handling single exchange
  const [exchangeAddress] = getExchangePda(0);
  const liquidator: Liquidator = {
    liquidatorMarginAccount: publicKey(liquidatorAddress),
    privateKeyString,
  };

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
  const highRiskStore: HighRiskStore[] = [
    { address: "7gUkzEhQtjzhrEtHpW1S12iaNvg8kaS4awghpgUjwhSa", score: 99 },
  ];
  const sdk = new ParclV3Sdk({ rpcUrl, commitment });
  const exchange = await sdk.accountFetcher.getExchange(exchangeAddress);
  if (!exchange) throw new Error("Invalid exchange address");

  // eslint-disable-next-line no-constant-condition
  const executeLiquidatorCycle = async (firstRun: boolean) => {
    try {
      const log = Date.now() - lastLog > 1000 * 60 * 5;
      if (log) lastLog = Date.now();
      const dataMaps = await fetchMarketData(exchange, exchangeAddress, sdk);
      const marketData = { exchange, dataMaps };
      const [markets] = dataMaps;
      if (firstRun) console.log(`Fetched ${Object.keys(markets).length} market and price feeds`);
      await processHighRiskAccounts(rpcUrl, liquidator, marketData, highRiskStore, instantCheck);

      const addressSlices = await getMarginAddressesFromSlice(rpcUrl, log);
      // TODO: this should only be done once, then subscribe to onProgramAccountChange with margin account filter
      // TODO: similarly, yellowstone/geyser can be used to subscribe to market + margin account updates

      // I was unable to access "Source Code URL	https://github.com/ParclFinance/parcl-v3"

      const highRisk = await checkAddresses(rpcUrl, addressSlices, liquidator, marketData, log);
      //replace stored high risk store with new one
      highRiskStore.length = 0;
      highRiskStore.push(...highRisk);
      setTimeout(() => executeLiquidatorCycle(false), interval * 1000);
    } catch (error) {
      console.error("Error during liquidator cycle:", error);
      setTimeout(() => executeLiquidatorCycle(false), interval * 1000);
    }
  };
  await executeLiquidatorCycle(true);
}
type MarketData = {
  exchange: Exchange;
  dataMaps: [MarketMap, PriceFeedMap];
};
async function processHighRiskAccounts(
  rpcUrl: string,
  liquidator: Liquidator,
  marketData: MarketData,
  highRiskStore: HighRiskStore[],
  instantCheck: number,
  log: boolean = false
) {
  if (highRiskStore.length > 0) {
    const highRiskScoreSorted = highRiskStore.sort((a, b) => b.score - a.score);
    if (highRiskScoreSorted.length < instantCheck)
      console.info(
        "Stored high risk accounts < INSTANT_CHECK_QUANTITY. Try lowering the threshold."
      );
    const slicedHighRisk = highRiskScoreSorted.slice(0, instantCheck);
    if (log)
      console.log(
        `Checking ${slicedHighRisk.length} high risk accounts. Highest is ${slicedHighRisk[0].address} with score ${slicedHighRisk[0].score}`
      );
    const highRiskAddresses = slicedHighRisk.map((a) => a.address);
    await checkAddresses(
      rpcUrl,
      highRiskAddresses,
      liquidator,
      marketData,
      log
      // highRiskAddresses[0]
    );
  } else {
    console.log("No high risk accounts in store.");
  }
}

// Note: this only works if you install the sdk locally and upgrade @solana/web3.js
// Otherwise:
// > Program logged: "AnchorError occurred. Error Code: InstructionDidNotDeserialize. Error Number: 102. Error Message: The program could not deserialize the given instruction."
// > Program consumed: 5492 of 1319700 compute units
// > Program returned error: "custom program error: 0x66"
// https://explorer.solana.com/tx/39tRrDyN1j8hMeyERczNvLHzymFY9gmQxfGCdwF6hpvowadSVRfq1KSBRNKBMLTTpGd7jXYfWW5DjhyWzTKpn37i
// With it locally installed:
// > Program logged: "AnchorError occurred. Error Code: MarginAccountIsNotLiquidatable. Error Number: 6079. Error Message: Margin account is not liquidatable."
// > Program consumed: 45578 of 1319700 compute units
// > Program returned error: "custom program error: 0x17bf"
// https://explorer.solana.com/tx/KaoLzaMKbmV3zuAefC8Kx5as8C1FZz4fDrpbA9rih6PVSWUSNeagqEtRQXddDiVxjyLyjXdGVJcN3VTV7DMivuj
