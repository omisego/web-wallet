/*
Copyright 2019-present OmiseGO Pte Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License. */

import Web3 from 'web3';
import WalletConnectProvider from '@walletconnect/web3-provider';
import { orderBy, flatten, uniq, get } from 'lodash';
import { ChildChain, RootChain, OmgUtil } from '@omisego/omg-js';
import BN from 'bn.js';
import axios from 'axios';
import JSONBigNumber from 'omg-json-bigint';
import { bufferToHex } from 'ethereumjs-util';
import erc20abi from 'human-standard-token-abi';

import store from 'store';
import { getToken } from 'actions/tokenAction';
import config from 'util/config';

class NetworkService {
  constructor () {
    this.web3 = null;
    this.provider = null;
    this.rootChain = null;
    this.childChain = new ChildChain({ watcherUrl: config.watcherUrl, plasmaContractAddress: config.plasmaAddress });
    this.OmgUtil = OmgUtil;
    this.plasmaContractAddress = config.plasmaAddress;
    this.isWalletConnect = false;
  }

  async enableWalletConnect () {
    try {
      this.provider = new WalletConnectProvider({
        rpc: {
          1: config.rpcProxy,
          3: config.rpcProxy,
          4: config.rpcProxy
        }
      });
      await this.provider.enable();
      this.web3 = new Web3(this.provider, null, { transactionConfirmationBlocks: 1 });
      this.isWalletConnect = true;
      this.bindProviderListeners();
      return true;
    } catch (error) {
      return false;
    }
  }

  async enableBrowserWallet () {
    this.isWalletConnect = false;
    try {
      if (window.ethereum) {
        this.provider = window.ethereum;
        await window.ethereum.enable();
      } else if (window.web3) {
        this.provider = window.web3.currentProvider;
      } else {
        return false;
      }
      this.web3 = new Web3(this.provider, null, { transactionConfirmationBlocks: 1 });
      this.bindProviderListeners();
      return true;
    } catch (error) {
      return false;
    }
  }

  handleAccountsChanged (accounts) {
    const providerRegisteredAccount = accounts ? accounts[0] : null;
    const appRegisteredAcount = networkService.account;
    if (!providerRegisteredAccount || !appRegisteredAcount) {
      return;
    }
    if (appRegisteredAcount.toLowerCase() !== providerRegisteredAccount.toLowerCase()) {
      window.location.reload(false);
    }
  }

  bindProviderListeners () {
    if (!this.isWalletConnect && window.ethereum) {
      try {
        window.ethereum.on('accountsChanged', function (accounts) {
          this.handleAccountsChanged();
        });
      } catch (err) {
        console.warn('Web3 event handling not available');
      }
    }

    if (this.isWalletConnect) {
      try {
        this.provider.on('accountsChanged', function (accounts) {
          this.handleAccountsChanged();
        });
        this.provider.on('close', function () {
          console.log('provider connection closed');
          // walletConnect connection closed
          window.location.reload(false);
        });
      } catch (err) {
        console.warn('WalletConnect event handling not available');
      }
    }
  }

  async initializeAccounts () {
    try {
      this.rootChain = new RootChain({ web3: this.web3, plasmaContractAddress: this.plasmaContractAddress });
      const accounts = await this.web3.eth.getAccounts();
      this.account = accounts[0];
      const network = await this.web3.eth.net.getNetworkType();
      return network === config.network;
    } catch (error) {
      console.log('error: ', error);
      return false;
    }
  }

  async checkStatus () {
    const { byzantine_events, last_seen_eth_block_timestamp } = await this.childChain.status();
    const currentUnix = Math.round((new Date()).getTime() / 1000);

    // filter out piggyback_available event from byzantine_events array, since its not a byzantine event!
    const filteredByzantineEvents = byzantine_events.filter(i =>  i.event !== 'piggyback_available');

    return {
      connection: !!byzantine_events,
      byzantine: !!filteredByzantineEvents.length,
      secondsSinceLastSync: currentUnix - last_seen_eth_block_timestamp,
      lastSeenBlock: last_seen_eth_block_timestamp
    };
  }

  async getAllTransactions () {
    const rawTransactions = await this.childChain.getTransactions({ address: this.account });
    const currencies = uniq(flatten(rawTransactions.map(i => i.inputs.map(input => input.currency))));
    await Promise.all(currencies.map(i => getToken(i)));

    const transactions = rawTransactions.map(i => {
      return {
        ...i,
        metadata: OmgUtil.transaction.decodeMetadata(i.metadata)
      };
    });
    return transactions;
  }

  async getBalances () {
    const _childchainBalances = await this.childChain.getBalance(this.account);
    const childchainBalances = await Promise.all(_childchainBalances.map(
      async i => {
        const token = await getToken(i.currency);
        return {
          ...token,
          amount: i.amount.toString()
        };
      }
    ));

    const rootErc20Balances = await Promise.all(childchainBalances.map(
      async i => {
        if (i.name !== 'ETH') {
          const balance = await OmgUtil.getErc20Balance({
            web3: this.web3,
            address: this.account,
            erc20Address: i.currency
          });
          return {
            ...i,
            amount: balance.toString()
          };
        }
      }
    ));

    const _rootEthBalance = await this.web3.eth.getBalance(this.account);
    const ethToken = await getToken(OmgUtil.transaction.ETH_CURRENCY);
    const rootchainEthBalance = {
      ...ethToken,
      amount: _rootEthBalance
    };

    return {
      rootchain: orderBy([ rootchainEthBalance, ...rootErc20Balances.filter(i => !!i) ], i => i.currency),
      childchain: orderBy(childchainBalances, i => i.currency)
    };
  }

  async depositEth (value, gasPrice) {
    const valueBN = new BN(value.toString());
    return this.rootChain.deposit({
      amount: valueBN,
      txOptions: {
        from: this.account,
        gasPrice: gasPrice.toString()
      }
    });
  }

  async depositErc20 (value, currency, gasPrice) {
    const valueBN = new BN(value.toString());
    return this.rootChain.deposit({
      amount: valueBN,
      currency,
      txOptions: {
        from: this.account,
        gasPrice: gasPrice.toString()
      }
    });
  }

  async checkAllowance (currency) {
    try {
      const tokenContract = new this.web3.eth.Contract(erc20abi, currency);
      const { address: erc20VaultAddress } = await this.rootChain.getErc20Vault();
      const allowance = await tokenContract.methods.allowance(this.account, erc20VaultAddress).call();
      return allowance.toString();
    } catch (error) {
      throw new Error('Error checking deposit allowance for ERC20');
    }
  }

  async approveErc20 (value, currency, gasPrice) {
    const valueBN = new BN(value.toString());
    return this.rootChain.approveToken({
      erc20Address: currency,
      amount: valueBN,
      txOptions: {
        from: this.account,
        gasPrice: gasPrice.toString()
      }
    });
  }

  async resetApprove (value, currency, gasPrice) {
    const valueBN = new BN(value.toString());
    // the reset approval
    await this.rootChain.approveToken({
      erc20Address: currency,
      amount: 0,
      txOptions: {
        from: this.account,
        gasPrice: gasPrice.toString()
      }
    });
    // approval for new amount
    return this.rootChain.approveToken({
      erc20Address: currency,
      amount: valueBN,
      txOptions: {
        from: this.account,
        gasPrice: gasPrice.toString()
      }
    });
  }

  // normalize signing methods across wallet providers
  // another unimplemented way to do the check is to detect the provider
  // https://ethereum.stackexchange.com/questions/24266/elegant-way-to-detect-current-provider-int-web3-js
  async signTypedData (typedData) {
    if (this.isWalletConnect) {
      // TODO DOESNT WORK
      const signature = await this.web3.eth.signTypedData(typedData);
      return signature;
    }

    function isExpectedError (message) {
      if (
        message.includes('The method eth_signTypedData_v3 does not exist')
        || message.includes('Invalid JSON RPC response')
      ) {
        return true;
      }
      return false;
    }

    try {
      const signature = await this.web3.currentProvider.send(
        'eth_signTypedData_v3',
        [
          this.web3.utils.toChecksumAddress(this.account),
          JSONBigNumber.stringify(typedData)
        ]
      );
      return signature;
    } catch (error) {
      if (!isExpectedError(error.message)) {
        // not an expected error
        throw error;
      }
      // method doesnt exist try another
    }

    // fallback signing method if signTypedData is not implemented by the provider
    const typedDataHash = OmgUtil.transaction.getToSignHash(typedData);
    const signature = await this.web3.eth.sign(
      bufferToHex(typedDataHash),
      this.web3.utils.toChecksumAddress(this.account)
    );
    return signature;
  }

  async mergeUtxos (utxos) {
    const _metadata = 'Merge UTXOs';
    const payments = [ {
      owner: this.account,
      currency: utxos[0].currency,
      amount: utxos.reduce((prev, curr) => {
        return prev.add(new BN(curr.amount));
      }, new BN(0))
    } ];
    const fee = {
      currency: OmgUtil.transaction.ETH_CURRENCY,
      amount: 0
    };
    const txBody = OmgUtil.transaction.createTransactionBody({
      fromAddress: this.account,
      fromUtxos: utxos,
      payments,
      fee,
      metadata: OmgUtil.transaction.encodeMetadata(_metadata)
    });
    const typedData = OmgUtil.transaction.getTypedData(txBody, this.plasmaContractAddress);
    const signature = await this.signTypedData(typedData);
    const signatures = new Array(txBody.inputs.length).fill(signature);
    const signedTxn = this.childChain.buildSignedTransaction(typedData, signatures);
    const submittedTransaction = await this.childChain.submitTransaction(signedTxn);
    return {
      ...submittedTransaction,
      block: {
        blknum: submittedTransaction.blknum,
        timestamp: Math.round((new Date()).getTime() / 1000)
      },
      metadata: _metadata,
      status: 'Pending'
    };
  }

  async fetchFees () {
    const allFees = await this.childChain.getFees();
    return allFees['1'];
  }

  async transfer ({
    recipient,
    value,
    currency,
    feeToken,
    metadata
  }) {
    const _utxos = await this.childChain.getUtxos(this.account);
    const utxos = orderBy(_utxos, i => i.amount, 'desc');

    const allFees = await this.fetchFees();
    const feeInfo = allFees.find(i => i.currency === feeToken);
    if (!feeInfo) throw new Error(`${feeToken} is not a supported fee token.`);

    const payments = [ {
      owner: recipient,
      currency,
      amount: new BN(value)
    } ];
    const fee = {
      currency: feeToken,
      amount: new BN(feeInfo.amount)
    };
    const txBody = OmgUtil.transaction.createTransactionBody({
      fromAddress: this.account,
      fromUtxos: utxos,
      payments,
      fee,
      metadata: metadata || OmgUtil.transaction.NULL_METADATA
    });
    const typedData = OmgUtil.transaction.getTypedData(txBody, this.plasmaContractAddress);
    const signature = await this.signTypedData(typedData);
    const signatures = new Array(txBody.inputs.length).fill(signature);
    const signedTxn = this.childChain.buildSignedTransaction(typedData, signatures);
    const submittedTransaction = await this.childChain.submitTransaction(signedTxn);
    return {
      ...submittedTransaction,
      block: {
        blknum: submittedTransaction.blknum,
        timestamp: Math.round((new Date()).getTime() / 1000)
      },
      metadata,
      status: 'Pending'
    };
  }

  async getUtxos () {
    const _utxos = await this.childChain.getUtxos(this.account);
    const utxos = await Promise.all(_utxos.map(async utxo => {
      const tokenInfo = await getToken(utxo.currency);
      return { ...utxo, tokenInfo };
    }));
    return utxos;
  }

  async getEthStats () {
    try {
      const currentETHBlockNumber = await this.web3.eth.getBlockNumber();
      return {
        currentETHBlockNumber
      };
    } catch (error) {
      return null;
    }
  }

  async getDeposits () {
    const depositFinality = 10;
    const { contract: ethVault } = await this.rootChain.getEthVault();
    const { contract: erc20Vault } = await this.rootChain.getErc20Vault();
    const state = store.getState();
    const ethBlockNumber = get(state, 'status.currentETHBlockNumber');

    let _ethDeposits = [];
    try {
      _ethDeposits = await ethVault.getPastEvents('DepositCreated', {
        filter: { depositor: this.account },
        fromBlock: 0
      });
    } catch (error) {
      console.log('Getting past ETH DepositCreated events timed out: ', error.message);
    }

    const ethDeposits = await Promise.all(_ethDeposits.map(async i => {
      const tokenInfo = await getToken(i.returnValues.token);
      const status = ethBlockNumber - i.blockNumber >= depositFinality ? 'Confirmed' : 'Pending';
      const pendingPercentage = (ethBlockNumber - i.blockNumber) / depositFinality;
      return { ...i, status, pendingPercentage: (pendingPercentage * 100).toFixed(), tokenInfo };
    }));

    let _erc20Deposits = [];
    try {
      _erc20Deposits = await erc20Vault.getPastEvents('DepositCreated', {
        filter: { depositor: this.account },
        fromBlock: 0
      });
    } catch (error) {
      console.log('Getting past ERC20 DepositCreated events timed out: ', error.message);
    }

    const erc20Deposits = await Promise.all(_erc20Deposits.map(async i => {
      const tokenInfo = await getToken(i.returnValues.token);
      const status = ethBlockNumber - i.blockNumber >= depositFinality ? 'Confirmed' : 'Pending';
      const pendingPercentage = (ethBlockNumber - i.blockNumber) / depositFinality;
      return { ...i, status, pendingPercentage: (pendingPercentage * 100).toFixed(), tokenInfo };
    }));

    return { eth: ethDeposits, erc20: erc20Deposits };
  }

  async getExits () {
    const finality = 12;
    const { contract } = await this.rootChain.getPaymentExitGame();
    const state = store.getState();
    const ethBlockNumber = get(state, 'status.currentETHBlockNumber');

    let allExits = [];
    try {
      allExits = await contract.getPastEvents('ExitStarted', {
        filter: { owner: this.account },
        fromBlock: 0
      });
    } catch (error) {
      console.log('Getting past ExitStarted events timed out: ', error.message);
    }

    const exitedExits = [];
    for (const exit of allExits) {
      let isFinalized = [];
      try {
        isFinalized = await contract.getPastEvents('ExitFinalized', {
          filter: { exitId: exit.returnValues.exitId.toString() },
          fromBlock: 0
        });
      } catch (error) {
        console.log('Getting past ExitFinalized events timed out: ', error.message);
      }
      if (isFinalized.length) {
        exitedExits.push(exit);
      }
    }

    const pendingExits = allExits
      .filter(i => {
        const foundMatch = exitedExits.find(x => x.blockNumber === i.blockNumber);
        return !foundMatch;
      })
      .map(i => {
        const status = ethBlockNumber - i.blockNumber >= finality ? 'Confirmed' : 'Pending';
        const pendingPercentage = (ethBlockNumber - i.blockNumber) / finality;
        return {
          ...i,
          status,
          pendingPercentage: (pendingPercentage * 100).toFixed()
        };
      });

    return {
      pending: pendingExits,
      exited: exitedExits
    };
  }

  async checkForExitQueue (token) {
    return this.rootChain.hasToken(token);
  }

  async getExitQueue (_currency) {
    const currency = _currency.toLowerCase();
    let queue = [];
    try {
      queue = await this.rootChain.getExitQueue(currency);
    } catch (error) {
      console.log('Getting the exitQueue timed out: ', error.message);
    }

    return {
      currency,
      queue: queue.map(i => ({
        ...i,
        currency
      }))
    };
  }

  async addExitQueue (token, gasPrice) {
    return this.rootChain.addToken({
      token,
      txOptions: {
        from: this.account,
        gasPrice: gasPrice.toString()
      }
    });
  }

  async exitUtxo (utxo, gasPrice) {
    const exitData = await this.childChain.getExitData(utxo);
    try {
      const res = await this.rootChain.startStandardExit({
        utxoPos: exitData.utxo_pos,
        outputTx: exitData.txbytes,
        inclusionProof: exitData.proof,
        txOptions: {
          from: this.account,
          gasPrice: gasPrice.toString()
        }
      });
      return res;
    } catch (error) {
      // some providers will fail on gas estimation
      // so try again but set the gas explicitly to avoid the estimiate
      // this has a negative effect of making the price estimation more expensive
      return this.rootChain.startStandardExit({
        utxoPos: exitData.utxo_pos,
        outputTx: exitData.txbytes,
        inclusionProof: exitData.proof,
        txOptions: {
          from: this.account,
          gasPrice: gasPrice.toString(),
          gas: 6000000
        }
      });
    }
  }

  async processExits (maxExits, currency, gasPrice) {
    return this.rootChain.processExits({
      token: currency,
      exitId: 0,
      maxExitsToProcess: maxExits,
      txOptions: {
        from: this.account,
        gasPrice: gasPrice.toString()
      }
    });
  }

  async getGasPrice () {
    // first try ethgasstation
    try {
      const { data: { safeLow, average, fast } } = await axios.get('https://ethgasstation.info/json/ethgasAPI.json');
      return {
        slow: safeLow * 100000000,
        normal: average * 100000000,
        fast: fast * 100000000
      };
    } catch (error) {
      //
    }

    // if not web3 oracle
    try {
      const _medianEstimate = await this.web3.eth.getGasPrice();
      const medianEstimate = Number(_medianEstimate);
      return {
        slow: Math.max(medianEstimate / 2, 1000000000),
        normal: medianEstimate,
        fast: medianEstimate * 5
      };
    } catch (error) {
      //
    }

    // if not these defaults
    return {
      slow: 1000000000,
      normal: 2000000000,
      fast: 10000000000
    };
  }
}

const networkService = new NetworkService();
export default networkService;
