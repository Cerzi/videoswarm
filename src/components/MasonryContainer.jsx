import React, { forwardRef } from 'react';

const MasonryContainer = forwardRef(({ 
  children, 
  className = '',
  ...props 
}, ref) => {
  return (
    <div 
      ref={ref}
      className={className}
      {...props}
    >
      {children}
    </div>
  );
});

MasonryContainer.displayName = 'MasonryContainer';

export default MasonryContainer;