import path from 'path';
import { push } from 'react-router-redux';
import {
  TezosFileWallet,
  TezosWalletUtil,
  TezosConseilClient,
  TezosNodeWriter,
  StoreType,
  TezosNodeReader
} from 'conseiljs';
import { addMessage } from '../../reduxContent/message/thunks';
import { CREATE, IMPORT } from '../../constants/CreationTypes';
import {
  FUNDRAISER,
  GENERATE_MNEMONIC,
  RESTORE
} from '../../constants/AddAddressTypes';
import { CONSEIL, TEZOS } from '../../constants/NodesTypes';
import { CREATED } from '../../constants/StatusTypes';
import { createTransaction } from '../../utils/transaction';

import {
  findAccountIndex,
  getSyncAccount,
  syncAccountWithState
} from '../../utils/account';

import {
  findIdentity,
  findIdentityIndex,
  createIdentity,
  getSyncIdentity,
  syncIdentityWithState
} from '../../utils/identity';

import {
  clearOperationId,
  getNodesStatus,
  getNodesError,
  getSelectedKeyStore
} from '../../utils/general';

import {
  saveUpdatedWallet,
  loadPersistedState,
  persistWalletState,
  loadWalletFromLedger
} from '../../utils/wallet';

import {
  logout,
  setWallet,
  setIsLoading,
  setWalletIsSyncing,
  setIdentities,
  setNodesStatus,
  addNewIdentity,
  updateIdentity,
  updateFetchedTime,
  setLedger,
  setIsLedgerConnecting
} from './actions';

import { getSelectedNode } from '../../utils/nodes';
import { getCurrentPath } from '../../utils/paths';
import { ACTIVATION } from '../../constants/TransactionTypes';

const {
  unlockFundraiserIdentity,
  unlockIdentityWithMnemonic,
  restoreIdentityWithSecretKey
} = TezosWalletUtil;
const { createWallet } = TezosFileWallet;

const { getAccount } = TezosConseilClient;

const {
  sendIdentityActivationOperation,
  sendKeyRevealOperation
} = TezosNodeWriter;
let currentAccountRefreshInterval = null;

export function goHomeAndClearState() {
  return dispatch => {
    dispatch(logout());
    clearAutomaticAccountRefresh();
    dispatch(push('/'));
  };
}

export function automaticAccountRefresh() {
  return dispatch => {
    const oneSecond = 1000; // milliseconds
    const oneMinute = 60 * oneSecond;
    const minutes = 1;
    const REFRESH_INTERVAL = minutes * oneMinute;

    if (currentAccountRefreshInterval) {
      clearAutomaticAccountRefresh();
    }

    currentAccountRefreshInterval = setInterval(
      () => dispatch(syncWallet()),
      REFRESH_INTERVAL
    );
  };
}

export function clearAutomaticAccountRefresh() {
  clearInterval(currentAccountRefreshInterval);
}

export function updateAccountActiveTab(
  selectedAccountHash,
  selectedParentHash,
  activeTab
) {
  return async (dispatch, state) => {
    const identities = state()
      .wallet.get('identities')
      .toJS();
    const identity = findIdentity(identities, selectedParentHash);
    const foundIndex = findAccountIndex(identity, selectedAccountHash);
    const account = identity.accounts[foundIndex];

    if (foundIndex > -1) {
      identity.accounts[foundIndex] = {
        ...account,
        activeTab
      };

      dispatch(updateIdentity(identity));
    }
  };
}

export function updateIdentityActiveTab(selectedAccountHash, activeTab) {
  return async (dispatch, state) => {
    const identities = state()
      .wallet.get('identities')
      .toJS();
    const identity = findIdentity(identities, selectedAccountHash);
    if (identity) {
      dispatch(
        updateIdentity({
          ...identity,
          activeTab
        })
      );
    }
  };
}

export function updateActiveTab(
  selectedAccountHash,
  selectedParentHash,
  activeTab
) {
  return async dispatch => {
    if (selectedAccountHash === selectedParentHash) {
      dispatch(updateIdentityActiveTab(selectedAccountHash, activeTab));
    } else {
      dispatch(
        updateAccountActiveTab(
          selectedAccountHash,
          selectedParentHash,
          activeTab
        )
      );
    }
  };
}

export function syncAccount(selectedAccountHash, selectedParentHash) {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const { network } = settings;
    const isLedger = state().wallet.get('isLedger');
    let identities = state()
      .wallet.get('identities')
      .toJS();
    let identity = findIdentity(identities, selectedParentHash);
    const foundIndex = findAccountIndex(identity, selectedAccountHash);
    let syncAccount = identity.accounts[foundIndex];

    if (foundIndex > -1) {
      syncAccount = await getSyncAccount(
        identities,
        syncAccount,
        settings,
        selectedAccountHash,
        selectedParentHash,
        isLedger,
        network
      ).catch(e => {
        console.log(
          `-debug: Error in: syncAccount for:${identity.publicKeyHash}`
        );
        console.error(e);
        return syncAccount;
      });
    }

    identities = state()
      .wallet.get('identities')
      .toJS();
    identity = findIdentity(identities, selectedParentHash);
    identity.accounts[foundIndex] = syncAccountWithState(
      syncAccount,
      identity.accounts[foundIndex]
    );
    dispatch(updateIdentity(identity));
    await persistWalletState(state().wallet.toJS());
  };
}

export function syncIdentity(publicKeyHash) {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const { network, platform } = settings;
    const identities = state()
      .wallet.get('identities')
      .toJS();
    const selectedAccountHash = state().wallet.get('selectedAccountHash');
    let stateIdentity = findIdentity(identities, publicKeyHash);

    const syncIdentity = await getSyncIdentity(
      identities,
      stateIdentity,
      settings,
      selectedAccountHash,
      network,
      platform
    ).catch(e => {
      console.log(`-debug: Error in: syncIdentity for:${publicKeyHash}`);
      console.error(e);
      return stateIdentity;
    });

    stateIdentity = findIdentity(
      state()
        .wallet.get('identities')
        .toJS(),
      publicKeyHash
    );

    dispatch(
      updateIdentity(syncIdentityWithState(syncIdentity, stateIdentity))
    );
    await persistWalletState(state().wallet.toJS());
  };
}

export function syncWallet() {
  return async (dispatch, state) => {
    dispatch(setWalletIsSyncing(true));
    const settings = state().settings.toJS();
    const { network, platform } = settings;
    const isLedger = state().wallet.get('isLedger');

    const nodesStatus = await getNodesStatus(settings, network);
    dispatch(setNodesStatus(nodesStatus));
    const res = getNodesError(nodesStatus);
    console.log('-debug: res, nodesStatus', res, nodesStatus);

    if (getNodesError(nodesStatus)) {
      dispatch(setWalletIsSyncing(false));
      return false;
    }

    let stateIdentities = state()
      .wallet.get('identities')
      .toJS();

    const syncIdentities = await Promise.all(
      (stateIdentities || []).map(async identity => {
        const { publicKeyHash, publicKey, privateKey } = identity;
        const { url } = getSelectedNode(settings, TEZOS);
        // todo: we will add isReveal field to the store later.
        const isReveal = await TezosNodeReader.isManagerKeyRevealedForAccount(
          url,
          publicKeyHash
        ).catch(err => {
          console.log('isreveal error---', err);
          return false;
        });
        if (!isReveal) {
          let keyStore = {
            publicKey,
            privateKey,
            publicKeyHash
          };
          let userDerivation = '';
          if (isLedger) {
            const { derivation } = getCurrentPath(settings);
            userDerivation = derivation;
            keyStore = { ...keyStore, storeType: 2 };
          }
          await sendKeyRevealOperation(url, keyStore, 1270, userDerivation);
        }
        const syncIdentity = await getSyncIdentity(
          stateIdentities,
          identity,
          settings,
          isLedger,
          network,
          platform
        ).catch(e => {
          console.log(`-debug: Error in: syncIdentity for: ${publicKeyHash}`);
          console.error(e);
          return identity;
        });
        return syncIdentity;
      })
    );

    stateIdentities = state()
      .wallet.get('identities')
      .toJS();

    const newIdentities = stateIdentities.filter(stateIdentity => {
      const syncIdentityIndex = syncIdentities.findIndex(
        syncIdentity =>
          stateIdentity.publicKeyHash === syncIdentity.publicKeyHash
      );

      if (syncIdentityIndex > -1) {
        syncIdentities[syncIdentityIndex] = syncIdentityWithState(
          syncIdentities[syncIdentityIndex],
          stateIdentity
        );
        return false;
      }

      return true;
    });

    dispatch(setIdentities(syncIdentities.concat(newIdentities)));
    dispatch(updateFetchedTime(new Date()));
    await persistWalletState(state().wallet.toJS());
    dispatch(setWalletIsSyncing(false));
  };
}

export function syncAccountOrIdentity(selectedAccountHash, selectedParentHash) {
  return async dispatch => {
    try {
      dispatch(setWalletIsSyncing(true));
      if (selectedAccountHash === selectedParentHash) {
        await dispatch(syncIdentity(selectedAccountHash));
      } else {
        await dispatch(syncAccount(selectedAccountHash, selectedParentHash));
      }
    } catch (e) {
      console.log(
        `-debug: Error in: syncAccountOrIdentity for:${selectedAccountHash}`,
        selectedParentHash
      );
      console.error(e);
      dispatch(addMessage(e.name, true));
    }
    dispatch(setWalletIsSyncing(false));
  };
}

export function importAddress(
  activeTab,
  seed,
  pkh,
  activationCode,
  username,
  passPhrase,
  sk
) {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const { wallet } = state();
    let identities = wallet.get('identities');
    const walletLocation = wallet.get('walletLocation');
    const walletFileName = wallet.get('walletFileName');
    const password = wallet.get('password');
    const { network } = settings;
    // TODO: clear out message bar
    dispatch(addMessage('', true));
    dispatch(setIsLoading(true));
    try {
      let identity = null;
      let activating;
      switch (activeTab) {
        case GENERATE_MNEMONIC:
          identity = await unlockIdentityWithMnemonic(seed, '');
          identity.storeType = StoreType.Mnemonic;
          break;
        case FUNDRAISER: {
          identity = await unlockFundraiserIdentity(
            seed,
            username.trim(),
            passPhrase.trim(),
            pkh.trim()
          );
          identity.storeType = StoreType.Fundraiser;
          const conseilNode = getSelectedNode(settings, CONSEIL);

          const account = await getAccount(
            { url: conseilNode.url, apiKey: conseilNode.apiKey },
            network,
            identity.publicKeyHash
          ).catch(() => []);
          if (!account || account.length === 0) {
            const tezosNode = getSelectedNode(settings, TEZOS);
            activating = await sendIdentityActivationOperation(
              tezosNode.url,
              identity,
              activationCode
            ).catch(err => {
              const error = err;
              error.name = err.message;
              throw error;
            });

            const operationId = clearOperationId(activating.operationGroupID);
            dispatch(
              addMessage(
                'components.messageBar.messages.success_account_activation',
                false,
                operationId
              )
            );
            identity.operations = {
              [CREATED]: operationId
            };
          }
          break;
        }
        case RESTORE: {
          if (sk !== undefined && sk.length > 0) {
            identity = await restoreIdentityWithSecretKey(sk);
          } else {
            identity = await unlockIdentityWithMnemonic(seed, passPhrase);
            const storeTypesMap = {
              0: StoreType.Mnemonic,
              1: StoreType.Fundraiser
            };
            identity.storeType = storeTypesMap[identity.storeType];
          }

          const conseilNode = getSelectedNode(settings, CONSEIL);
          const account = await getAccount(
            { url: conseilNode.url, apiKey: conseilNode.apiKey },
            network,
            identity.publicKeyHash
          ).catch(() => []);

          if (!account || account.length === 0) {
            const title = 'components.messageBar.messages.account_not_exist';
            const err = new Error(title);
            err.name = title;
            throw err;
          }
          break;
        }
        default:
          break;
      }

      if (identity) {
        const { publicKeyHash } = identity;
        const jsIdentities = identities.toJS();
        if (findIdentityIndex(jsIdentities, publicKeyHash) === -1) {
          delete identity.seed;
          identity.order = jsIdentities.length + 1;
          identity = createIdentity(identity);
          if (activating !== undefined) {
            identity.transactions.push(
              createTransaction({
                kind: ACTIVATION,
                timestamp: Date.now(),
                operation_group_hash: identity.operations.Created,
                amount:
                  activating.results.contents[0].metadata.balance_updates[0]
                    .change
              })
            );
          }
          dispatch(addNewIdentity(identity));
          identities = state()
            .wallet.get('identities')
            .toJS();
          await saveUpdatedWallet(
            identities,
            walletLocation,
            walletFileName,
            password
          );
          await persistWalletState(state().wallet.toJS());
          dispatch(setIsLoading(false));
          dispatch(push('/home'));
          await dispatch(syncAccountOrIdentity(publicKeyHash, publicKeyHash));
        } else {
          dispatch(
            addMessage('components.messageBar.messages.identity_exist', true)
          );
        }
      }
    } catch (e) {
      console.log(`-debug: Error in: importAddress for:${activeTab}`);
      console.error(e);
      if (e.name === "The provided string doesn't look like hex data") {
        dispatch(addMessage('general.errors.no_hex_data', true));
      } else {
        dispatch(addMessage(e.name, true));
      }

      dispatch(setIsLoading(false));
    }
  };
}

// todo: 3 on create account success add that account to file - incase someone closed wallet before ready was finish.
export function login(loginType, walletLocation, walletFileName, password) {
  return async dispatch => {
    const completeWalletPath = path.join(walletLocation, walletFileName);
    dispatch(addMessage('', true));
    dispatch(setLedger(false));
    try {
      let wallet = {};
      if (loginType === CREATE) {
        wallet = await createWallet(completeWalletPath, password);
      } else if (loginType === IMPORT) {
        wallet = await loadPersistedState(completeWalletPath, password);
      }

      const identities = wallet.identities.map((identity, identityIndex) => {
        return createIdentity({
          ...identity,
          order: identity.order || identityIndex + 1
        });
      });

      dispatch(
        setWallet(
          {
            identities,
            walletLocation,
            walletFileName,
            password
          },
          'wallet'
        )
      );

      dispatch(automaticAccountRefresh());
      dispatch(setIsLoading(false));
      dispatch(push('/home'));
      await dispatch(syncWallet());
    } catch (e) {
      console.error(e);
      dispatch(setIsLoading(false));
      dispatch(addMessage(e.name, true));
    }
  };
}

// todo: 3 on create account success add that account to file - incase someone closed wallet before ready was finish.
export function connectLedger() {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const { derivation } = await getCurrentPath(settings);
    dispatch(setLedger(true));
    dispatch(setIsLedgerConnecting(true));
    dispatch(setIsLoading(true));
    dispatch(addMessage('', true));
    try {
      const wallet = await loadWalletFromLedger(derivation);
      const identities = wallet.identities.map((identity, identityIndex) => {
        return createIdentity({
          ...identity,
          order: identity.order || identityIndex + 1
        });
      });

      dispatch(
        setWallet(
          {
            isLoading: true,
            identities,
            walletLocation: '',
            walletFileName: `Ledger Nano S - ${derivation}`
          },
          'wallet'
        )
      );

      dispatch(automaticAccountRefresh());
      dispatch(push('/home'));
      await dispatch(syncWallet());
    } catch (e) {
      console.error(e);
      dispatch(addMessage(e.name, true));
    }
    dispatch(setIsLoading(false));
    dispatch(setIsLedgerConnecting(false));
  };
}

export function getIsReveal(selectedAccountHash, selectedParentHash) {
  return async (dispatch, state) => {
    const identities = state()
      .wallet.get('identities')
      .toJS();
    const settings = state().settings.toJS();
    const { publicKeyHash } = getSelectedKeyStore(
      identities,
      selectedAccountHash,
      selectedParentHash
    );

    const { url } = getSelectedNode(settings, TEZOS);

    const isReveal = await TezosNodeReader.isManagerKeyRevealedForAccount(
      url,
      publicKeyHash
    ).catch(err => {
      console.log('isreveal error---', err);
      return false;
    });
    return isReveal;
  };
}

export function getIsImplicitAndEmpty(recipientHash) {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const { url } = getSelectedNode(settings, TEZOS);
    const isImplicitAndEmpty = await TezosNodeReader.isImplicitAndEmpty(
      url,
      recipientHash
    );
    return isImplicitAndEmpty;
  };
}
