import React from 'react';

import * as styles from './Info.module.scss';

function Info ({ data }) {
  return (
    <div className={styles.Info}>
      {data.map((i, index) => (
        <div key={index}>
          {i.header && (
            <div className={styles.header}>{i.header}</div>
          )}
          <div className={styles.item}>
            <span>{i.title}</span>
            <span>{i.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export default Info;