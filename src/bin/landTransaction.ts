import {
  TransactionBuilder,
  Umi,
  PublicKey as UmiPublicKey,
  //   Keypair as UmiKeypair,
  createSignerFromKeypair,
  publicKey,
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
  fromWeb3JsTransaction,
  toWeb3JsLegacyTransaction,
  toWeb3JsPublicKey,
} from "@metaplex-foundation/umi-web3js-adapters";
import { getSimulationComputeUnits } from "@solana-developers/helpers";
import {
  AddressLookupTableAccount,
  Connection,
  VersionedTransaction,
  Transaction as Web3Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";

// https://www.helius.dev/blog/how-to-land-transactions-on-solana
const MAX_SECONDS_TO_SEND_TRANSACTION = 110; // s
const MAX_RETRIES = 50; // count
const MAX_LOOPS = 5; // count
const RETRY_DELAY = 100; // ms
const TX_RETRY_INTERVAL = 1000; // ms

export async function sendAndConfirmTransactionOptimized(
  transaction: Web3Transaction | VersionedTransaction,
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
  const feePayerArr = typeof feePayer === "string" ? bs58.decode(feePayer) : feePayer;
  const umiKeypair = umi.eddsa.createKeypairFromSecretKey(feePayerArr);
  const umiSigner = createSignerFromKeypair({ eddsa: umi.eddsa }, umiKeypair);
  umi.use(signerIdentity(umiSigner));

  //   const txMessage =
  //     transaction instanceof Web3Transaction
  //       ? umi.transactions.deserializeMessage(transaction.serializeMessage())
  //       : umi.transactions.deserializeMessage(fromWeb3JsTransaction(transaction).serializedMessage);

  // const ixs = toWeb3JsInstructions(txMessage.instructions);
  const umiTransaction = umi.transactions.create({
    instructions:
      transaction instanceof Web3Transaction
        ? transaction.instructions.map((ix) => ({
            keys: ix.keys.map((k) => ({
              pubkey: publicKey(k.pubkey),
              isSigner: k.isSigner,
              isWritable: k.isWritable,
            })),
            programId: publicKey(ix.programId),
            data: ix.data,
          }))
        : toWeb3JsLegacyTransaction(
            umi.transactions.deserialize(transaction.serialize())
          ).instructions.map((ix) => fromWeb3JsInstruction(ix)),
    payer: umiSigner.publicKey,
    blockhash: "",
  });

  const fixMeIxs =
    transaction instanceof Web3Transaction
      ? transaction.instructions.map((ix) => fromWeb3JsInstruction(ix))
      : toWeb3JsLegacyTransaction(fromWeb3JsTransaction(transaction)).instructions.map((ix) =>
          fromWeb3JsInstruction(ix)
        );
  const wrappedIxs = fixMeIxs.map((ix) => ({
    instruction: ix,
    signers: [umi.payer],
    bytesCreatedOnChain: 0,
  }));

  const priorityFee = await getPriorityFeeEstimate(
    heliusEndpoint,
    bs58.encode(
      (
        await transactionBuilder(wrappedIxs).buildWithLatestBlockhash(umi, {
          commitment: "confirmed",
        })
      ).serializedMessage
    )
  );
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
    .prepend(setComputeUnitPrice(umi, { microLamports: priorityFee }))
    .prepend(setComputeUnitLimit(umi, { units: computeUnitLimit }))
    .setAddressLookupTables(luts)
    .setFeePayer(umi.payer);

  for (let retries = 0; retries < MAX_LOOPS; retries++) {
    try {
      const signature = await sendAndConfirmWithRetry(finalTransaction, umi, connection);
      if (signature) {
        return bs58.encode(signature);
      } else {
        break;
        // throw new Error("Transaction confirmation failed");
      }
    } catch (error) {
      console.error(`Attempt ${retries + 1} failed:`, error);
      if (retries === MAX_RETRIES - 1) {
        throw new Error(`Failed to send transaction after ${MAX_RETRIES} attempts`);
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
    }
  }

  throw new Error("Unexpected error in retry loop");
}

async function sendAndConfirmWithRetry(
  finalTx: TransactionBuilder,
  umi: Umi,
  connection: Connection
): Promise<Uint8Array | null> {
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
    if ((Date.now() - startTime) / 1000 > MAX_SECONDS_TO_SEND_TRANSACTION) {
      throw new Error("Transaction took too long to send");
    }
    try {
      txSignature = signedTx.signatures[0];
      let txSendAttempts = 1;

      console.log(`${new Date().toISOString()} Subscribing to transaction confirmation`);

      // confirmTransaction throws error, handle it
      confirmTransactionPromise = await umi.rpc.confirmTransaction(txSignature, {
        strategy: { type: "blockhash", blockhash, lastValidBlockHeight },
        commitment: "confirmed",
        minContextSlot: minContextSlot,
      });

      console.log(`${new Date().toISOString()} Sending Transaction ${txSignature}`);
      let sig = await umi.rpc.sendTransaction(signedTx, {
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
        sig = await umi.rpc.sendTransaction(signedTx, {
          skipPreflight: true,
          commitment: "confirmed",
          maxRetries: 0,
          minContextSlot,
          preflightCommitment: "confirmed",
        });
        console.log({ sig });
      }
    } catch (error) {
      console.error(`${new Date().toISOString()} Error: ${error}`);
      console.log(`Send transaction failed, retrying (${attempt + 1}/${MAX_RETRIES})...`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!confirmedTx) {
      console.log(`${new Date().toISOString()} Transaction failed`);
      return null;
    }
    console.log(`${new Date().toISOString()} Transaction successful`);
    console.log(
      `${new Date().toISOString()} Explorer URL: https://explorer.solana.com/tx/${txSignature}`
    );
    return txSignature;
  }

  //   if (!sig) {
  //     throw new Error("Failed to send transaction");
  //   }

  //   if (result.value.err) {
  //     throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
  //   }

  return null;
}

async function getPriorityFeeEstimate(
  heliusUrl: string,
  serializedTransaction: string
): Promise<number> {
  // const connection = new Connection(heliusUrl);
  // transaction: bs58.encode(transaction.serialize()),
  //   const serializedTransaction = transaction.buildWithLatestBlockhash(umi, {commitment: "confirmed"}).serialize(
  const response = await fetch(heliusUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      priorityLevel: "high",
      transaction: serializedTransaction,
    }),
  });
  const { priorityFeeEstimate } = await response.json();
  return priorityFeeEstimate;
}
