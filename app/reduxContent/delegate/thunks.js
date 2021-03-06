import { TezosProtocolHelper } from 'conseiljs';
import { addMessage } from '../../reduxContent/message/thunks';
import { updateIdentity } from '../../reduxContent/wallet/actions';
import { displayError } from '../../utils/formValidation';
import { getSelectedNode } from '../../utils/nodes';
import { getCurrentPath } from '../../utils/paths';
import { findIdentity } from '../../utils/identity';
import { findAccountIndex } from '../../utils/account';
import { TEZOS } from '../../constants/NodesTypes';
import { persistWalletState } from '../../utils/wallet';
import { createTransaction } from '../../utils/transaction';
import { DELEGATION } from '../../constants/TransactionTypes';

import {
  getSelectedKeyStore,
  fetchAverageFees,
  clearOperationId
} from '../../utils/general';

const { setDelegate } = TezosProtocolHelper;

export function fetchDelegationAverageFees() {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const averageFees = await fetchAverageFees(settings, 'delegation');
    return averageFees;
  };
}

export function validateAddress(address) {
  return async dispatch => {
    const validations = [
      { value: address, type: 'notEmpty', name: 'address' },
      { value: address, type: 'validAddress' }
    ];

    const error = displayError(validations);
    if (error) {
      dispatch(addMessage(error, true));
      return false;
    }

    return true;
  };
}

export function delegate(
  delegateValue,
  fee,
  password,
  selectedAccountHash,
  selectedParentHash
) {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const isLedger = state().wallet.get('isLedger');
    const identities = state()
      .wallet.get('identities')
      .toJS();
    const walletPassword = state().wallet.get('password');

    if (password !== walletPassword && !isLedger) {
      const error = 'components.messageBar.messages.incorrect_password';
      dispatch(addMessage(error, true));
      return false;
    }

    const keyStore = getSelectedKeyStore(
      identities,
      selectedParentHash,
      selectedParentHash
    );
    const { url } = getSelectedNode(settings, TEZOS);
    let res;
    if (isLedger) {
      const newKeyStore = keyStore;
      const { derivation } = getCurrentPath(settings);
      newKeyStore.storeType = 2;
      res = await setDelegate(
        url,
        newKeyStore,
        selectedAccountHash,
        delegateValue,
        fee,
        derivation
      ).catch(err => {
        const errorObj = { name: err.message, ...err };
        console.error(errorObj);
        dispatch(addMessage(errorObj.name, true));
        return false;
      });
    } else {
      res = await setDelegate(
        url,
        keyStore,
        selectedAccountHash,
        delegateValue,
        fee
      ).catch(err => {
        const errorObj = { name: err.message, ...err };
        console.error(errorObj);
        dispatch(addMessage(errorObj.name, true));
        return false;
      });
    }

    if (res) {
      const operationResult =
        res &&
        res.results &&
        res.results.contents &&
        res.results.contents[0] &&
        res.results.contents[0].metadata &&
        res.results.contents[0].metadata.operation_result;

      if (
        operationResult &&
        operationResult.errors &&
        operationResult.errors.length
      ) {
        const error =
          'components.messageBar.messages.delegation_operation_failed';
        console.error(error);
        dispatch(addMessage(error, true));
        return false;
      }

      const clearedOperationId = clearOperationId(res.operationGroupID);

      dispatch(
        addMessage(
          'components.messageBar.messages.success_delegation_update',
          false,
          clearedOperationId
        )
      );

      const transaction = createTransaction({
        delegate: delegateValue,
        kind: DELEGATION,
        source: keyStore.publicKeyHash,
        operation_group_hash: clearedOperationId,
        fee
      });

      const identity = findIdentity(identities, selectedParentHash);

      if (selectedParentHash === selectedAccountHash) {
        identity.transactions.push(transaction);
      } else {
        const accountIndex = findAccountIndex(identity, selectedAccountHash);
        if (accountIndex > -1) {
          identity.accounts[accountIndex].transactions.push(transaction);
        }
      }

      dispatch(updateIdentity(identity));

      await persistWalletState(state().wallet.toJS());
      return true;
    }
    return false;
  };
}
