import config from "../config";
import async from 'async';
import {
  SNACKBAR_ERROR,
  SNACKBAR_TRANSACTION_RECEIPT,
  SNACKBAR_TRANSACTION_CONFIRMED,
  ERROR,
  GET_BALANCES_PERPETUAL,
  BALANCES_PERPETUAL_RETURNED,
  GET_LP_BALANCES,
  LP_BALANCES_RETURNED,
  DEPOSIT_LP,
  DEPOSIT_LP_RETURNED,
  DEPOSIT_ALL_LP,
  DEPOSIT_ALL_LP_RETURNED,
  WITHDRAW_LP,
  WITHDRAW_LP_RETURNED,
  WITHDRAW_ALL_LP,
  WITHDRAW_ALL_LP_RETURNED,
  GET_INSURED_BALANCES,
  INSURED_BALANCES_RETURNED,
  DEPOSIT_INSURED,
  DEPOSIT_INSURED_RETURNED,
  DEPOSIT_ALL_INSURED,
  DEPOSIT_ALL_INSURED_RETURNED,
  WITHDRAW_INSURED,
  WITHDRAW_INSURED_RETURNED,
  WITHDRAW_ALL_INSURED,
  WITHDRAW_ALL_INSURED_RETURNED,
} from '../constants';
import Web3 from 'web3';

import {
  injected,
  walletconnect,
  walletlink,
  ledger,
  trezor,
  frame,
  fortmatic,
  portis,
  squarelink,
  torus,
  authereum
} from "./connectors";

const rp = require('request-promise');

const Dispatcher = require('flux').Dispatcher;
const Emitter = require('events').EventEmitter;

const dispatcher = new Dispatcher();
const emitter = new Emitter();

class Store {
  constructor() {

    this.store = {
      universalGasPrice: '70',
      account: {},
      connectorsByName: {
        MetaMask: injected,
        TrustWallet: injected,
        WalletConnect: walletconnect,
        WalletLink: walletlink,
        Ledger: ledger,
        Trezor: trezor,
        Frame: frame,
        Fortmatic: fortmatic,
        Portis: portis,
        Squarelink: squarelink,
        Torus: torus,
        Authereum: authereum
      },
      web3context: null,
      ethBalance: 0,
      lpAssets: [
        {
          id: 'USDC',
          name: 'USD Coin',
          symbol: 'USDC',
          description: 'USD//C',
          vaultSymbol: 'yiUSDC',
          erc20address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          vaultContractAddress: config.LPVaultContractAddress,
          vaultContractABI: config.LPVaultContractABI,
          balance: 0,
          vaultBalance: 0,
          decimals: 6,
        }
      ],
      insuredAssets: [
        {
          id: 'yUSD',
          name: 'Wrapped yCRV',
          symbol: 'yUSD',
          description: 'Wrapped yCRV',
          insuredSymbol: 'iyUSD',
          erc20address: '0x5dbcF33D8c2E976c6b560249878e6F1491Bca25c',
          insuranceContractAddress: config.InsuredVaultContractAddress,
          insuranceContractABI: config.InsuredVaultContractABI,
          balance: 0,
          insuredBalance: 0,
          decimals: 18,
        }
      ],
    }

    dispatcher.register(
      function (payload) {
        switch (payload.type) {
          case GET_BALANCES_PERPETUAL:
            this.getBalancesPerpetual(payload);
            break;
          case GET_LP_BALANCES:
            this.getLPBalances(payload);
            break;
          case DEPOSIT_LP:
            this.depositLP(payload)
            break;
          case DEPOSIT_ALL_LP:
            this.depositAllLP(payload)
            break;
          case WITHDRAW_LP:
            this.withdrawLP(payload)
            break;
          case WITHDRAW_ALL_LP:
            this.withdrawAllLP(payload)
            break;
          case GET_INSURED_BALANCES:
            this.getInsuredBalances(payload);
            break;
          case DEPOSIT_INSURED:
            this.depositInsured(payload)
            break;
          case DEPOSIT_ALL_INSURED:
            this.depositAllInsured(payload)
            break;
          case WITHDRAW_INSURED:
            this.withdrawInsured(payload)
            break;
          case WITHDRAW_ALL_INSURED:
            this.withdrawAllInsured(payload)
            break;
          default: {
          }
        }
      }.bind(this)
    );
  }

  getStore(index) {
    return(this.store[index]);
  };

  setStore(obj) {
    this.store = {...this.store, ...obj}
    // console.log(this.store)
    return emitter.emit('StoreUpdated');
  };

  _checkApproval = async (asset, account, amount, contract, callback) => {
    try {
      const web3 = this._getProvider()
      const erc20Contract = new web3.eth.Contract(config.erc20ABI, asset.erc20address)
      const allowance = await erc20Contract.methods.allowance(account.address, contract).call({ from: account.address })

      let ethAllowance = web3.utils.fromWei(allowance, "ether")
      if (asset.decimals !== 18) {
        ethAllowance = (allowance*10**asset.decimals).toFixed(0);
      }

      var amountToSend = web3.utils.toWei('999999999', "ether")
      if (asset.decimals !== 18) {
        amountToSend = (999999999*10**asset.decimals).toFixed(0);
      }

      if(parseFloat(ethAllowance) < parseFloat(amount)) {
        await erc20Contract.methods.approve(contract, amountToSend).send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
        callback()
      } else {
        callback()
      }
    } catch(error) {
      if(error.message) {
        return callback(error.message)
      }
      callback(error)
    }
  }

  getBalancesPerpetual = async () => {
    const account = store.getStore('account')
    const lpAssets = store.getStore('lpAssets')
    const insuredAssets = store.getStore('insuredAssets')

    const web3 = this._getProvider()

    async.parallel([
      (callback) => { this._getLPBalancesPerpetual(web3, lpAssets, account, callback) },
      (callback) => { this._getInsuredBalancesPerpetual(web3, insuredAssets, account, callback) },
    ], (err, assets) => {
      if(err) {
        return emitter.emit(ERROR, err)
      }

      store.setStore({ lpAssets: assets[0], insuredAssets: assets[1] })

      emitter.emit(BALANCES_PERPETUAL_RETURNED, assets)
      emitter.emit(LP_BALANCES_RETURNED, assets[0])
      emitter.emit(INSURED_BALANCES_RETURNED, assets[1])
    })
  }

  _getInsuredBalancesPerpetual= (web3, assets, account, cb) => {
    async.map(assets, (asset, callback) => {
      async.parallel([
        (callbackInner) => { this._getERC20Balance(web3, asset, account, callbackInner) },
        (callbackInner) => { this._getInsuredBalance(web3, asset, account, callbackInner) },
      ], (err, data) => {
        asset.balance = data[0]
        asset.insuredBalance = data[1]

        callback(null, asset)
      })
    }, cb)
  }

  _getLPBalancesPerpetual = (web3, assets, account, cb) => {
    async.map(assets, (asset, callback) => {
      async.parallel([
        (callbackInner) => { this._getERC20Balance(web3, asset, account, callbackInner) },
        (callbackInner) => { this._getVaultBalance(web3, asset, account, callbackInner) },
        (callbackInner) => { this._getVaultPricePerFullShare(web3, asset, account, callbackInner) },
      ], (err, data) => {
        asset.balance = data[0]
        asset.vaultBalance = data[1]
        asset.pricePerFullShare = data[2]

        callback(null, asset)
      })
    }, cb)
  }

  getLPBalances = async () => {
    const account = store.getStore('account')
    const assets = store.getStore('lpAssets')

    const web3 = this._getProvider()

    async.map(assets, (asset, callback) => {
      async.parallel([
        (callbackInner) => { this._getERC20Balance(web3, asset, account, callbackInner) },
        (callbackInner) => { this._getVaultBalance(web3, asset, account, callbackInner) },
        (callbackInner) => { this._getVaultPricePerFullShare(web3, asset, account, callbackInner) },
      ], (err, data) => {
        asset.balance = data[0]
        asset.vaultBalance = data[1]
        asset.pricePerFullShare = data[2]

        callback(null, asset)
      })
    }, (err, assets) => {
      if(err) {
        return emitter.emit(ERROR, err)
      }

      store.setStore({ assets: assets })
      emitter.emit(LP_BALANCES_RETURNED, assets)
    })
  }

  _getERC20Balance = async (web3, asset, account, callback) => {
    try {
      const erc20Contract = new web3.eth.Contract(config.erc20ABI, asset.erc20address)

      let balance = await erc20Contract.methods.balanceOf(account.address).call({ from: account.address });
      balance = parseFloat(balance)/10**asset.decimals
      callback(null, parseFloat(balance))
    } catch(ex) {
      console.log(ex)
      return callback(ex)
    }
  }

  _getVaultBalance = async (web3, asset, account, callback) => {
    try {
      const vaultContract = new web3.eth.Contract(asset.vaultContractABI, asset.vaultContractAddress)

      let balance = await vaultContract.methods.balanceOf(account.address).call({ from: account.address });
      balance = parseFloat(balance)/10**asset.decimals
      callback(null, parseFloat(balance))
    } catch(ex) {
      console.log(ex)
      return callback(ex)
    }
  }

  _getVaultPricePerFullShare = async (web3, asset, account, callback) => {
    try {
      const vaultContract = new web3.eth.Contract(asset.vaultContractABI, asset.vaultContractAddress)

      let price = await vaultContract.methods.getPricePerFullShare().call({ from: account.address });
      price = parseFloat(price)/10**18
      callback(null, parseFloat(price))
    } catch(ex) {
      console.log(ex)
      return callback(ex)
    }
  }

  depositLP = (payload) => {
    const account = store.getStore('account')
    const { asset, amount } = payload.content

    this._checkApproval(asset, account, amount, asset.vaultContractAddress, (err) => {
      if(err) {
        return emitter.emit(ERROR, err);
      }

      this._callDepositLP(asset, account, amount, (err, depositResult) => {
        if(err) {
          return emitter.emit(ERROR, err);
        }

        return emitter.emit(DEPOSIT_LP_RETURNED, depositResult)
      })
    })
  }

  _callDepositLP = async (asset, account, amount, callback) => {
    const web3 = this._getProvider()

    const vaultContract = new web3.eth.Contract(asset.vaultContractABI, asset.vaultContractAddress)

    var amountToSend = web3.utils.toWei(amount, "ether")
    if (asset.decimals !== 18) {
      amountToSend = (amount*10**asset.decimals).toFixed(0);
    }

    vaultContract.methods.deposit(amountToSend).send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
      .on('transactionHash', function(hash){
        emitter.emit(SNACKBAR_TRANSACTION_RECEIPT, hash)
        callback(null, hash)
      })
      .on('confirmation', function(confirmationNumber, receipt){
        if(confirmationNumber === 2) {
          emitter.emit(SNACKBAR_TRANSACTION_CONFIRMED, receipt.transactionHash)
          callback(null, receipt.transactionHash)
        }
      })
      .on('error', function(error) {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
      .catch((error) => {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
  }

  depositAllLP = (payload) => {
    const account = store.getStore('account')
    const { asset } = payload.content

    this._checkApproval(asset, account, asset.balance, asset.vaultContractAddress, (err) => {
      if(err) {
        return emitter.emit(ERROR, err);
      }

      this._callDepositAllLP(asset, account, (err, depositResult) => {
        if(err) {
          return emitter.emit(ERROR, err);
        }

        return emitter.emit(DEPOSIT_ALL_LP_RETURNED, depositResult)
      })
    })
  }

  _callDepositAllLP = async (asset, account, callback) => {
    const web3 = this._getProvider()

    const vaultContract = new web3.eth.Contract(asset.vaultContractABI, asset.vaultContractAddress)

    vaultContract.methods.depositAll().send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
      .on('transactionHash', function(hash){
        emitter.emit(SNACKBAR_TRANSACTION_RECEIPT, hash)
        callback(null, hash)
      })
      .on('confirmation', function(confirmationNumber, receipt){
        if(confirmationNumber === 2) {
          emitter.emit(SNACKBAR_TRANSACTION_CONFIRMED, receipt.transactionHash)
          callback(null, receipt.transactionHash)
        }
      })
      .on('error', function(error) {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
      .catch((error) => {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
  }

  withdrawLP = (payload) => {
    const account = store.getStore('account')
    const { asset, amount } = payload.content

    this._callWithdrawLP(asset, account, amount, (err, withdrawResult) => {
      if(err) {
        return emitter.emit(ERROR, err);
      }
      return emitter.emit(WITHDRAW_LP_RETURNED, withdrawResult)
    })
  }

  _callWithdrawLP = async (asset, account, amount, callback) => {
    const web3 = this._getProvider()

    const vaultContract = new web3.eth.Contract(asset.vaultContractABI, asset.vaultContractAddress)

    var amountSend = web3.utils.toWei(amount, "ether")
    if (asset.decimals !== 18) {
      amountSend = amount*10**asset.decimals;
    }

    vaultContract.methods.withdraw(amountSend).send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
      .on('transactionHash', function(hash){
        emitter.emit(SNACKBAR_TRANSACTION_RECEIPT, hash)
        callback(null, hash)
      })
      .on('confirmation', function(confirmationNumber, receipt){
        if(confirmationNumber === 2) {
          emitter.emit(SNACKBAR_TRANSACTION_CONFIRMED, receipt.transactionHash)
          callback(null, receipt.transactionHash)
        }
      })
      .on('error', function(error) {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
      .catch((error) => {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
  }

  withdrawAllLP = (payload) => {
    const account = store.getStore('account')
    const { asset } = payload.content

    this._callWithdrawAllLP(asset, account, (err, withdrawResult) => {
      if(err) {
        return emitter.emit(ERROR, err);
      }
      return emitter.emit(WITHDRAW_ALL_LP_RETURNED, withdrawResult)
    })
  }

  _callWithdrawAllLP = async (asset, account, callback) => {
    const web3 = this._getProvider()

    const vaultContract = new web3.eth.Contract(asset.vaultContractABI, asset.vaultContractAddress)

    vaultContract.methods.withdrawAll().send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
      .on('transactionHash', function(hash){
        emitter.emit(SNACKBAR_TRANSACTION_RECEIPT, hash)
        callback(null, hash)
      })
      .on('confirmation', function(confirmationNumber, receipt){
        if(confirmationNumber === 2) {
          emitter.emit(SNACKBAR_TRANSACTION_CONFIRMED, receipt.transactionHash)
          callback(null, receipt.transactionHash)
        }
      })
      .on('error', function(error) {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
      .catch((error) => {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
  }

  getInsuredBalances = async () => {
    const account = store.getStore('account')
    const assets = store.getStore('insuredAssets')

    const web3 = this._getProvider()

    async.map(assets, (asset, callback) => {
      async.parallel([
        (callbackInner) => { this._getERC20Balance(web3, asset, account, callbackInner) },
        (callbackInner) => { this._getInsuredBalance(web3, asset, account, callbackInner) },
      ], (err, data) => {
        asset.balance = data[0]
        asset.insuredBalance = data[1]

        callback(null, asset)
      })
    }, (err, assets) => {
      if(err) {
        return emitter.emit(ERROR, err)
      }

      store.setStore({ assets: assets })
      emitter.emit(INSURED_BALANCES_RETURNED, assets)
    })
  }

  _getInsuredBalance = async (web3, asset, account, callback) => {
    try {
      const vaultContract = new web3.eth.Contract(asset.insuranceContractABI, asset.insuranceContractAddress)

      let balance = await vaultContract.methods.balanceOf(account.address).call({ from: account.address });
      balance = parseFloat(balance)/10**asset.decimals
      callback(null, parseFloat(balance))
    } catch(ex) {
      console.log(ex)
      return callback(ex)
    }
  }


  depositInsured = (payload) => {
    const account = store.getStore('account')
    const { asset, amount } = payload.content

    this._checkApproval(asset, account, amount, asset.insuranceContractAddress, (err) => {
      if(err) {
        return emitter.emit(ERROR, err);
      }

      this._callDepositInsured(asset, account, amount, (err, depositResult) => {
        if(err) {
          return emitter.emit(ERROR, err);
        }

        return emitter.emit(DEPOSIT_INSURED_RETURNED, depositResult)
      })
    })
  }

  _callDepositInsured = async (asset, account, amount, callback) => {
    const web3 = this._getProvider()

    const insuranceContract = new web3.eth.Contract(asset.insuranceContractABI, asset.insuranceContractAddress)

    var amountToSend = web3.utils.toWei(amount, "ether")
    if (asset.decimals !== 18) {
      amountToSend = (amount*10**asset.decimals).toFixed(0);
    }

    insuranceContract.methods.deposit(amountToSend).send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
      .on('transactionHash', function(hash){
        emitter.emit(SNACKBAR_TRANSACTION_RECEIPT, hash)
        callback(null, hash)
      })
      .on('confirmation', function(confirmationNumber, receipt){
        if(confirmationNumber === 2) {
          emitter.emit(SNACKBAR_TRANSACTION_CONFIRMED, receipt.transactionHash)
          callback(null, receipt.transactionHash)
        }
      })
      .on('error', function(error) {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
      .catch((error) => {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
  }

  depositAllInsured = (payload) => {
    const account = store.getStore('account')
    const { asset } = payload.content

    this._checkApproval(asset, account, asset.balance, asset.insuranceContractAddress, (err) => {
      if(err) {
        return emitter.emit(ERROR, err);
      }

      this._callDepositAllInsured(asset, account, (err, depositResult) => {
        if(err) {
          return emitter.emit(ERROR, err);
        }

        return emitter.emit(DEPOSIT_ALL_INSURED_RETURNED, depositResult)
      })
    })
  }

  _callDepositAllInsured = async (asset, account, callback) => {
    const web3 = this._getProvider()

    const insuranceContract = new web3.eth.Contract(asset.insuranceContractABI, asset.insuranceContractAddress)

    insuranceContract.methods.depositAll().send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
      .on('transactionHash', function(hash){
        emitter.emit(SNACKBAR_TRANSACTION_RECEIPT, hash)
        callback(null, hash)
      })
      .on('confirmation', function(confirmationNumber, receipt){
        if(confirmationNumber === 2) {
          emitter.emit(SNACKBAR_TRANSACTION_CONFIRMED, receipt.transactionHash)
          callback(null, receipt.transactionHash)
        }
      })
      .on('error', function(error) {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
      .catch((error) => {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
  }

  withdrawInsured = (payload) => {
    const account = store.getStore('account')
    const { asset, amount } = payload.content

    this._callWithdrawInsured(asset, account, amount, (err, withdrawResult) => {
      if(err) {
        return emitter.emit(ERROR, err);
      }
      return emitter.emit(WITHDRAW_INSURED_RETURNED, withdrawResult)
    })
  }

  _callWithdrawInsured = async (asset, account, amount, callback) => {
    const web3 = this._getProvider()

    const insuranceContract = new web3.eth.Contract(asset.insuranceContractABI, asset.insuranceContractAddress)

    var amountSend = web3.utils.toWei(amount, "ether")
    if (asset.decimals !== 18) {
      amountSend = amount*10**asset.decimals;
    }

    insuranceContract.methods.withdraw(amountSend).send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
      .on('transactionHash', function(hash){
        emitter.emit(SNACKBAR_TRANSACTION_RECEIPT, hash)
        callback(null, hash)
      })
      .on('confirmation', function(confirmationNumber, receipt){
        if(confirmationNumber === 2) {
          emitter.emit(SNACKBAR_TRANSACTION_CONFIRMED, receipt.transactionHash)
          callback(null, receipt.transactionHash)
        }
      })
      .on('error', function(error) {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
      .catch((error) => {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
  }

  withdrawAllInsured = (payload) => {
    const account = store.getStore('account')
    const { asset } = payload.content

    this._callWithdrawAllInsured(asset, account, (err, withdrawResult) => {
      if(err) {
        return emitter.emit(ERROR, err);
      }
      return emitter.emit(WITHDRAW_ALL_INSURED_RETURNED, withdrawResult)
    })
  }

  _callWithdrawAllInsured = async (asset, account, callback) => {
    const web3 = this._getProvider()

    const insuranceContract = new web3.eth.Contract(asset.insuranceContractABI, asset.insuranceContractAddress)

    insuranceContract.methods.withdrawAll().send({ from: account.address, gasPrice: web3.utils.toWei(await this._getGasPrice(), 'gwei') })
      .on('transactionHash', function(hash){
        emitter.emit(SNACKBAR_TRANSACTION_RECEIPT, hash)
        callback(null, hash)
      })
      .on('confirmation', function(confirmationNumber, receipt){
        if(confirmationNumber === 2) {
          emitter.emit(SNACKBAR_TRANSACTION_CONFIRMED, receipt.transactionHash)
          callback(null, receipt.transactionHash)
        }
      })
      .on('error', function(error) {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
      .catch((error) => {
        if (!error.toString().includes("-32601")) {
          if(error.message) {
            emitter.emit(SNACKBAR_ERROR, error.message)
            return callback(error.message)
          }
          emitter.emit(SNACKBAR_ERROR, error)
          callback(error)
        }
      })
  }

  _getGasPrice = async () => {
    try {
      const url = 'https://gasprice.poa.network/'
      const priceString = await rp(url);
      const priceJSON = JSON.parse(priceString)
      if(priceJSON) {
        return priceJSON.fast.toFixed(0)
      }
      return store.getStore('universalGasPrice')
    } catch(e) {
      console.log(e)
      return store.getStore('universalGasPrice')
    }
  }

  _getProvider = () => {
    const web3 = new Web3(store.getStore('web3context').library.provider);
    return web3
  }
}

var store = new Store();

export default {
  store: store,
  dispatcher: dispatcher,
  emitter: emitter
};
