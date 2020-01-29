import React from 'react';

import * as styles from './Transaction.module.scss';

function Transaction ({
  link,
  status,
  statusPercentage,
  subStatus,
  button,
  title,
  midTitle,
  subTitle
}) {
  function renderValue () {
    if (button) {
      return (
        <div
          onClick={button.onClick}
          className={styles.button}
        >
          {button.text}
        </div>
      );
    }
    return (
      <div className={styles.statusContainer}>
        <div className={styles.status}>
          <div
            className={[
              styles.indicator,
              status === 'Pending' ? styles.pending : '',
              status === 'Exited' ? styles.exited : '',
              status === 'Failed' ? styles.failed : ''
            ].join(' ')}
          />
            <span>{status}</span>
            {status === 'Pending' && statusPercentage && (
              <span className={styles.percentage}>{`(${statusPercentage}%)`}</span>
            )}
        </div>
        <div>{subStatus}</div>
      </div>
    );
  }

  const Resolved = link ? 'a' : 'div';
  return (
    <div className={styles.Transaction}>
      <Resolved
        href={link}
        target={'_blank'}
        rel='noopener noreferrer'
        className={styles.left}
      >
        <div>{title}</div>
        {midTitle && (
          <div className={styles.midTitle}>{midTitle}</div>
        )}
        <div>{subTitle}</div>
      </Resolved>
      <div className={styles.right}>
        {renderValue()} 
      </div>
    </div>
  );
}

export default Transaction;
