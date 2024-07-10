import {
  TransactionBuilder,
  Umi,
  PublicKey as UmiPublicKey,
  //   Keypair as UmiKeypair,
  createSignerFromKeypair,
  signerIdentity,
  transactionBuilder,
} from "@metaplex-foundation/umi";
import { createUmi } from "@metaplex-foundation/umi-bundle-defaults";
// import { createWeb3JsRpc } from "@metaplex-foundation/umi-rpc-web3js";
import {
  fetchAllAddressLookupTable,
  mplToolbox,
  setComputeUnitLimit,
  setComputeUnitPrice,
} from "@metaplex-foundation/mpl-toolbox";
import {
  fromWeb3JsInstruction,
  fromWeb3JsLegacyTransaction,
  fromWeb3JsTransaction,
  toWeb3JsLegacyTransaction,
  toWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";
import { getSimulationComputeUnits } from "@solana-developers/helpers";
import {
  AddressLookupTableAccount,
  Connection,
  TransactionInstruction,
  VersionedTransaction,
  Transaction as Web3Transaction,
} from "@solana/web3.js";
import { decode, encode } from "bs58";

const MAX_RETRIES = 50; // count
const MAX_LOOPS = 5; // count
const RETRY_DELAY = 100; // ms
const TX_RETRY_INTERVAL = 1400; // ms
const MAX_SECONDS_TO_SEND_TRANSACTION = 110; // s
// https://www.helius.dev/blog/how-to-land-transactions-on-solana
// https://docs.triton.one/chains/solana/sending-txs
// https://github.com/rpcpool/optimized-txs-examples/blob/main/jupiterSwap.mjs

type TransactionInput = Web3Transaction | VersionedTransaction | TransactionInstruction[];

//  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

//  const getExponentialBackoff = (attempt: number, baseDelay: number = INITIAL_RETRY_DELAY) =>
//    Math.min(baseDelay * Math.pow(2, attempt), 10000);

export async function sendAndConfirmTransactionOptimized(
  transaction: TransactionInput,
  privateKey?: string | Uint8Array,
  lookupTables: UmiPublicKey[] = []
  //   signer?: string | Uint8Array
): Promise<string> {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("Missing RPC URL");
  const heliusEndpoint = rpc.includes("helius") ? rpc : process.env.HELIUS_URL;
  if (!heliusEndpoint) throw new Error("Missing Helius URL");
  const feePayer = privateKey ?? process.env.FEE_PAYER;
  if (!feePayer) throw new Error("Missing private key for fee payer");

  const connection = new Connection(rpc, "confirmed");
  const umi = createUmi(rpc).use(mplToolbox());

  // check if keypair is string, if so convert to Uint8Array
  const feePayerArr = typeof feePayer === "string" ? decode(feePayer) : feePayer;
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(feePayerArr);
  const umiSigner = createSignerFromKeypair({ eddsa: umi.eddsa }, umiKeypair);
  umi.use(signerIdentity(umiSigner));

  //   const txMessage =
  //     transaction instanceof Web3Transaction
  //       ? umi.transactions.deserializeMessage(transaction.serializeMessage())
  //       : umi.transactions.deserializeMessage(fromWeb3JsTransaction(transaction).serializedMessage);

  // const ixs = toWeb3JsInstructions(txMessage.instructions);
  const umiTransaction =
    transaction instanceof VersionedTransaction
      ? fromWeb3JsTransaction(transaction)
      : transaction instanceof Web3Transaction
      ? fromWeb3JsLegacyTransaction(transaction)
      : umi.transactions.create({
          instructions: transaction.map((ix) => fromWeb3JsInstruction(ix)),
          payer: umiSigner.publicKey,
          blockhash: "",
        });
  //   toWeb3JsLegacyTransaction(
  //             umi.transactions.deserialize(transaction.serialize())
  //           ).instructions.map((ix) => fromWeb3JsInstruction(ix))
  const serializedTxMsg = encode(umiTransaction.serializedMessage);
  console.log({ serializedTxMsg });
  const fixMeIxs =
    transaction instanceof Web3Transaction
      ? transaction.instructions.map((ix) => fromWeb3JsInstruction(ix))
      : transaction instanceof VersionedTransaction
      ? toWeb3JsLegacyTransaction(fromWeb3JsTransaction(transaction)).instructions.map((ix) =>
          fromWeb3JsInstruction(ix)
        )
      : transaction.map((ix) => fromWeb3JsInstruction(ix));
  const wrappedIxs = fixMeIxs.map((ix) => ({
    instruction: ix,
    signers: [umi.payer],
    bytesCreatedOnChain: 0,
  }));

  //   if (lookupTables.length === 0) { this works but adds time
  //     const addresses = fixMeIxs
  //       .map((ix) => ix.keys)
  //       .flat()
  //       .map((k) => k.pubkey);
  //     console.log({ addresses });
  //     const [lutBuilder, lut] = createLut(umi, {
  //       recentSlot: BigInt(await umi.rpc.getSlot({ commitment: "finalized" }) - 5),
  //       addresses,
  //     });
  //     await lutBuilder.sendAndConfirm(umi);
  //     lookupTables.push(lut.publicKey);
  //     console.log({ lut });
  //   }
  //   const serializedBase58Tx = encode(
  //     (
  //       await transactionBuilder(wrappedIxs).buildWithLatestBlockhash(umi, {
  //         commitment: "confirmed",
  //       })
  //     ).serializedMessage
  //   );
  const accountKeys = umiTransaction.message.accounts;
  const priorityFee = await getPriorityFeeEstimate(heliusEndpoint, accountKeys);
  console.log({ priorityFee });

  const luts = lookupTables.length > 0 ? await fetchAllAddressLookupTable(umi, lookupTables) : [];
  const simulationResult = await getSimulationComputeUnits(
    connection,
    toWeb3JsLegacyTransaction(umiTransaction).instructions,
    toWeb3JsPublicKey(umi.payer.publicKey),
    luts.length > 0
      ? luts.map(
          (table) =>
            new AddressLookupTableAccount({
              key: toWeb3JsPublicKey(table.publicKey),
              state: {
                deactivationSlot: table.deactivationSlot,
                lastExtendedSlot: Number(table.lastExtendedSlot),
                lastExtendedSlotStartIndex: table.lastExtendedStartIndex,
                // authority: table.authority,
                addresses: table.addresses.map((address) => toWeb3JsPublicKey(address)),
              },
            })
        )
      : []
  );
  console.log({ simulationResult });

  // Calculate optimal compute unit limit
  //   const computeUnits = simulationResult.result.unitsConsumed || 1_200_000;
  const computeUnits = simulationResult || 1_200_000;
  const computeUnitLimit = Math.ceil(computeUnits * 1.1); // Add 10% buffer

  // Construct final transaction with optimal compute unit limit
  const finalTransaction = await transactionBuilder(wrappedIxs)
    .prepend(setComputeUnitPrice(umi, { microLamports: Math.ceil(priorityFee) }))
    .prepend(setComputeUnitLimit(umi, { units: computeUnitLimit }))
    .setAddressLookupTables(luts)
    .setFeePayer(umi.payer);
  for (let retries = 0; retries < MAX_LOOPS; retries++) {
    console.log("looping");
    try {
      const signature = await sendAndConfirmWithRetry(finalTransaction, umi, connection);
      if (signature) {
        console.log(`Transaction confirmed: ${signature}`);
        return signature;
      } else {
        console.log("Transaction failed, retrying...");
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        // throw new Error("Transaction confirmation failed");
      }
    } catch (error) {
      console.error(`Attempt ${retries + 1} failed:`, error);
      if (retries === MAX_RETRIES - 1) {
        throw new Error(`Failed to send transaction after ${MAX_RETRIES} attempts`);
      }
      break;
    }
  }

  throw new Error("Unexpected error in retry loop");
}

async function sendAndConfirmWithRetry(
  finalTx: TransactionBuilder,
  umi: Umi,
  connection: Connection
): Promise<string | null> {
  // record the time and response time of getLatestBlockhashAndContext:
  const startTime = Date.now();
  console.time(`${new Date(startTime).toISOString()}: Total transaction time`);

  //   let signature: string | null = null;
  //   let lastValidBlockHeight: number;
  //   let minContextSlot: number;

  console.time(`${new Date().toISOString()}: getLatestBlockhashAndContext`);
  const { context, value } = (await connection.getLatestBlockhashAndContext("confirmed")) as {
    context: { slot: number };
    value: { blockhash: string; lastValidBlockHeight: number };
  };
  console.timeEnd(`${new Date().toISOString()}: getLatestBlockhashAndContext`);
  const { blockhash, lastValidBlockHeight } = value;
  const minContextSlot = context.slot;

  let txSignature: Uint8Array | null = null;
  let confirmTransactionPromise = null;
  let confirmedTx = null;

  const signedTx = await finalTx.setBlockhash(blockhash).buildAndSign(umi);

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    console.log(`${new Date().toISOString()} Attempt ${attempt + 1}/${MAX_RETRIES}`);
    if (confirmedTx) {
      console.log(`${new Date().toISOString()} Transaction confirmed`);
      break;
    }
    if ((Date.now() - startTime) / 1000 > MAX_SECONDS_TO_SEND_TRANSACTION) {
      console.error(`${new Date().toISOString()} Transaction took too long to send`);
      throw new Error("Transaction took too long to send");
    }
    if ((await connection.getBlockHeight()) > lastValidBlockHeight) {
      console.log(`${new Date().toISOString()} Blockhash expired, retrying...`);
      break;
    }
    try {
      txSignature = signedTx.signatures[0];
      let txSendAttempts = 1;

      console.log(`${new Date().toISOString()} Subscribing to transaction confirmation`);

      // confirmTransaction throws error, handle it
      confirmTransactionPromise = umi.rpc.confirmTransaction(txSignature, {
        strategy: { type: "blockhash", blockhash, lastValidBlockHeight },
        commitment: "confirmed",
        minContextSlot: minContextSlot,
      });

      console.log(`${new Date().toISOString()} Sending Transaction ${encode(txSignature)}`);
      await umi.rpc.sendTransaction(signedTx, {
        skipPreflight: true,
        commitment: "confirmed",
        maxRetries: 0,
        minContextSlot,
        preflightCommitment: "confirmed",
      });
      //   signature = await connection.sendRawTransaction(serializedTransaction, options);
      confirmedTx = null;
      while (!confirmedTx) {
        confirmedTx = await Promise.race([
          confirmTransactionPromise,
          new Promise((resolve) =>
            setTimeout(() => {
              resolve(null);
            }, TX_RETRY_INTERVAL)
          ),
        ]);
        if (confirmedTx) {
          break;
        }

        console.log(
          `${new Date().toISOString()} Tx not confirmed after ${
            TX_RETRY_INTERVAL * txSendAttempts++
          }ms, resending`
        );
        await umi.rpc.sendTransaction(signedTx, {
          skipPreflight: true,
          commitment: "confirmed",
          maxRetries: 0,
          minContextSlot,
          preflightCommitment: "confirmed",
        });
      }
    } catch (error) {
      console.error(`${new Date().toISOString()} Error: ${error}`);
      console.log(`Send transaction failed, retrying (${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!confirmedTx || !txSignature) {
      console.log(`${new Date().toISOString()} Transaction failed`);
      return null;
    }
    console.log(`${new Date().toISOString()} Transaction successful`);
    console.log(
      `${new Date().toISOString()} Explorer URL: https://explorer.solana.com/tx/${encode(
        txSignature
      )}`
    );
    return encode(txSignature);
  }

  //   if (!sig) {
  //     throw new Error("Failed to send transaction");
  //   }

  //   if (result.value.err) {
  //     throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  //   }

  return null;
}

async function getPriorityFeeEstimate(heliusUrl: string, accountKeys: string[]): Promise<number> {
  const response = await fetch(heliusUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "my-id",
      method: "getPriorityFeeEstimate",
      params: [
        {
          accountKeys,
          //   transaction: serializedTransaction,
          options: { includeAllPriorityFeeLevels: true },
        },
      ],
    }),
  });
  const { result } = await response.json();
  //   console.log({ result });
  // {
  //     result: {
  //       priorityFeeLevels: {
  //         min: 0,
  //         low: 500,
  //         medium: 32250,
  //         high: 269922.25,
  //         veryHigh: 3000000,
  //         unsafeMax: 2000000000,
  //       },
  //     },
  //   }
  return result.priorityFeeLevels?.high ?? 1;
}
