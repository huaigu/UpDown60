// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface AggregatorV3Interface {
    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80);
}

contract MockAggregatorV3 is AggregatorV3Interface {
    uint80 private roundId;
    int256 private price;
    uint256 private updatedAt;

    function setLatestRoundData(int256 _price, uint256 _updatedAt) external {
        price = _price;
        updatedAt = _updatedAt;
        roundId += 1;
    }

    function latestRoundData()
        external
        view
        returns (uint80, int256, uint256, uint256, uint80)
    {
        return (roundId, price, updatedAt, updatedAt, roundId);
    }
}
