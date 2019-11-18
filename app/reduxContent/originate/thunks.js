import { TezosNodeWriter, TezosProtocolHelper } from 'conseiljs';
import { updateIdentity } from '../../reduxContent/wallet/actions';
import { addMessage } from '../../reduxContent/message/thunks';
import { displayError } from '../../utils/formValidation';
import { tezToUtez } from '../../utils/currancy';
import { createAccount } from '../../utils/account';
import { findIdentity } from '../../utils/identity';
import { getSelectedNode } from '../../utils/nodes';
import { getCurrentPath } from '../../utils/paths';
import { TEZOS } from '../../constants/NodesTypes';
import { CREATED } from '../../constants/StatusTypes';
import { persistWalletState } from '../../utils/wallet';
import { createTransaction } from '../../utils/transaction';
import { ORIGINATION } from '../../constants/TransactionTypes';

import {
  getSelectedKeyStore,
  fetchAverageFees,
  clearOperationId
} from '../../utils/general';

const { sendContractOriginationOperation } = TezosNodeWriter;
const { deployManagerContract } = TezosProtocolHelper;

export function fetchOriginationAverageFees() {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const averageFees = await fetchAverageFees(settings, 'origination');
    return averageFees;
  };
}

export function originateContract(
  delegate,
  amount,
  fee,
  passPhrase,
  publicKeyHash,
  storageLimit = 0,
  gasLimit = 0,
  code,
  storage,
  codeFormat,
  isSmartContract = false
) {
  return async (dispatch, state) => {
    const settings = state().settings.toJS();
    const isLedger = state().wallet.get('isLedger');
    const walletPassword = state().wallet.get('password');
    const identities = state()
      .wallet.get('identities')
      .toJS();
    const parsedAmount = Number(amount.replace(/,/g, '.'));
    const amountInUtez = tezToUtez(parsedAmount);
    let validations = [];

    if (isLedger) {
      validations = [
        { value: amount, type: 'notEmpty', name: 'amount' },
        { value: parsedAmount, type: 'validAmount' },
        { value: amountInUtez, type: 'posNum', name: 'Amount' }
      ];
    } else {
      validations = [
        { value: amount, type: 'notEmpty', name: 'amount' },
        { value: parsedAmount, type: 'validAmount' },
        { value: amountInUtez, type: 'posNum', name: 'Amount' },
        { value: passPhrase, type: 'notEmpty', name: 'pass' },
        { value: passPhrase, type: 'minLength8', name: 'Pass Phrase' }
      ];
    }

    const error = displayError(validations);
    if (error) {
      dispatch(addMessage(error, true));
      return false;
    }

    if (passPhrase !== walletPassword && !isLedger) {
      const error = 'components.messageBar.messages.incorrect_password';
      dispatch(addMessage(error, true));
      return false;
    }

    const identity = findIdentity(identities, publicKeyHash);
    const keyStore = getSelectedKeyStore(
      identities,
      publicKeyHash,
      publicKeyHash
    );
    const { url } = getSelectedNode(settings, TEZOS);
    let userKeyStore = { ...keyStore };
    let userDerivation = '';

    if (isLedger) {
      const { derivation } = getCurrentPath(settings);
      userDerivation = derivation;
      userKeyStore = { ...userKeyStore, storeType: 2 };
    }

    let newAddress;

    if (isSmartContract) {
      newAddress = await sendContractOriginationOperation(
        url,
        userKeyStore,
        amountInUtez,
        delegate.length > 0 ? delegate : undefined,
        fee,
        userDerivation,
        storageLimit,
        gasLimit,
        code,
        storage,
        codeFormat
      ).catch(err => {
        const errorObj = { name: err.message, ...err };
        console.error(errorObj);
        dispatch(addMessage(errorObj.name, true));
        return false;
      });
    } else {
      newAddress = await deployManagerContract(
        url,
        userKeyStore,
        delegate,
        fee,
        amountInUtez,
        userDerivation
      ).catch(err => {
        const errorObj = { name: err.message, ...err };
        console.error(errorObj);
        dispatch(addMessage(errorObj.name, true));
        return false;
      });
    }

    if (newAddress) {
      const operationResult1 =
        newAddress &&
        newAddress.results &&
        newAddress.results.contents &&
        newAddress.results.contents.length;
      if (!operationResult1) {
        const error =
          'components.messageBar.messages.origination_operation_failed';
        console.error(error);
        dispatch(addMessage(error, true));
        return false;
      }
      const newOperation = newAddress.results.contents.find(
        content => content.kind === 'origination'
      );

      if (!newOperation) {
        const error =
          'components.messageBar.messages.origination_operation_failed';
        console.error(error);
        dispatch(addMessage(error, true));
        return false;
      }
      const operationResult =
        newOperation &&
        newOperation.metadata &&
        newOperation.metadata.operation_result;

      if (
        operationResult &&
        operationResult.errors &&
        operationResult.errors.length
      ) {
        const error =
          'components.messageBar.messages.origination_operation_failed';
        console.error(error);
        dispatch(addMessage(error, true));
        return false;
      }

      const newAddressHash = operationResult.originated_contracts[0];
      const operationId = clearOperationId(newAddress.operationGroupID);

      identity.accounts.push(
        createAccount(
          {
            account_id: newAddressHash,
            balance: amountInUtez,
            manager: publicKeyHash,
            delegate: '',
            operations: {
              [CREATED]: operationId
            },
            order: (identity.accounts.length || 0) + 1,
            script: isSmartContract ? JSON.stringify(code) : ''
          },
          identity
        )
      );

      identity.transactions.push(
        createTransaction({
          delegate,
          kind: ORIGINATION,
          operation_group_hash: operationId,
          source: keyStore.publicKeyHash,
          balance: amountInUtez,
          originated_contracts: newAddressHash,
          fee
        })
      );

      const delegatedAddressee = identity.accounts.filter(
        account => account.account_id === newAddressHash
      );
      delegatedAddressee[0].transactions.push(
        createTransaction({
          amount: amountInUtez,
          delegate,
          kind: ORIGINATION,
          operation_group_hash: operationId,
          destination: keyStore.publicKeyHash
        })
      );

      dispatch(updateIdentity(identity));

      // todo: add transaction
      if (isSmartContract) {
        dispatch(
          addMessage(
            'components.messageBar.messages.success_contract_origination',
            false,
            operationId
          )
        );
      } else {
        dispatch(
          addMessage(
            'components.messageBar.messages.success_address_origination',
            false,
            operationId
          )
        );
      }

      await persistWalletState(state().wallet.toJS());
      return true;
    }

    return false;
  };
}
